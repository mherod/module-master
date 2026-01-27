import path from "node:path";
import ts from "typescript";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanModuleReferences } from "../core/scanner.ts";
import type { ModuleReference, ProjectConfig } from "../types.ts";

export interface AliasOptions {
	target: string;
	prefer: "alias" | "relative" | "shortest";
	dryRun?: boolean;
	verbose?: boolean;
	project?: string;
}

export interface AliasResult {
	filesProcessed: number;
	importsUpdated: number;
	changes: AliasChange[];
}

export interface AliasChange {
	file: string;
	line: number;
	oldSpecifier: string;
	newSpecifier: string;
	strategy: string;
}

export async function aliasCommand(options: AliasOptions): Promise<void> {
	const {
		target,
		prefer,
		dryRun = false,
		verbose = false,
		project: projectArg,
	} = options;

	const absoluteTarget = path.resolve(target);

	// Find and load project config
	const tsconfigPath = resolveTsConfig(projectArg, absoluteTarget);
	if (!tsconfigPath) {
		console.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath);

	console.log(`\n${dryRun ? "🔍 Dry run:" : "🔧"} Normalizing imports...`);
	console.log(`   Target: ${absoluteTarget}`);
	console.log(`   Strategy: ${prefer}`);
	console.log();

	const result = await normalizeImports(absoluteTarget, prefer, project);

	if (result.changes.length === 0) {
		console.log(
			"✨ No changes needed. All imports already follow the preferred style.\n",
		);
		return;
	}

	// Apply changes if not dry run
	if (!dryRun) {
		applyChanges(result.changes);
	}

	printResults(result, dryRun, verbose);
}

async function normalizeImports(
	target: string,
	prefer: "alias" | "relative" | "shortest",
	project: ProjectConfig,
): Promise<AliasResult> {
	const changes: AliasChange[] = [];
	const filesToProcess = getFilesToProcess(target, project);

	for (const file of filesToProcess) {
		const references = await getFileReferences(file, project);

		for (const ref of references) {
			// Skip external packages (node_modules, built-in modules)
			if (
				!ref.resolvedPath.includes(project.rootDir) ||
				ref.resolvedPath.includes("node_modules") ||
				!ref.specifier.startsWith(".")
			) {
				continue;
			}

			const newSpecifier = calculatePreferredSpecifier(
				file,
				ref.resolvedPath,
				prefer,
				project,
			);

			if (newSpecifier && newSpecifier !== ref.specifier) {
				changes.push({
					file,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
					strategy: prefer,
				});
			}
		}
	}

	return {
		filesProcessed: filesToProcess.length,
		importsUpdated: changes.length,
		changes,
	};
}

function applyChanges(changes: AliasChange[]): void {
	// Group changes by file
	const byFile = new Map<string, AliasChange[]>();
	for (const change of changes) {
		const existing = byFile.get(change.file) ?? [];
		existing.push(change);
		byFile.set(change.file, existing);
	}

	for (const [filePath, fileChanges] of byFile) {
		let content = ts.sys.readFile(filePath);
		if (!content) continue;

		// Sort changes by line number (descending) to avoid offset issues
		const sorted = [...fileChanges].sort((a, b) => b.line - a.line);

		// Apply each change
		for (const change of sorted) {
			// Simple string replacement approach
			// This works for most cases, but could be improved with AST-based replacement
			const oldImport = new RegExp(
				`(['"\`])${escapeRegex(change.oldSpecifier)}\\1`,
				"g",
			);
			content = content.replace(oldImport, `$1${change.newSpecifier}$1`);
		}

		ts.sys.writeFile(filePath, content);
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFilesToProcess(target: string, project: ProjectConfig): string[] {
	const stat = ts.sys.fileExists(target)
		? "file"
		: ts.sys.directoryExists(target)
			? "directory"
			: null;

	if (stat === "file") {
		return [target];
	}

	if (stat === "directory") {
		return project.files.filter((f) => f.startsWith(target));
	}

	return [];
}

async function getFileReferences(
	filePath: string,
	project: ProjectConfig,
): Promise<ModuleReference[]> {
	const program = createProgram(project, [filePath]);
	const sourceFile = program.getSourceFile(filePath);

	if (!sourceFile) {
		return [];
	}

	return scanModuleReferences(sourceFile, project);
}

function calculatePreferredSpecifier(
	fromFile: string,
	toFile: string,
	prefer: "alias" | "relative" | "shortest",
	project: ProjectConfig,
): string | null {
	const relativeSpecifier = calculateRelativeSpecifier(fromFile, toFile);
	const aliasSpecifier = findMatchingAlias(toFile, project);

	if (prefer === "relative") {
		return relativeSpecifier;
	}

	if (prefer === "alias") {
		return aliasSpecifier ?? relativeSpecifier;
	}

	if (prefer === "shortest") {
		if (!aliasSpecifier) return relativeSpecifier;
		return relativeSpecifier.length <= aliasSpecifier.length
			? relativeSpecifier
			: aliasSpecifier;
	}

	return null;
}

function calculateRelativeSpecifier(fromFile: string, toFile: string): string {
	const fromDir = path.dirname(fromFile);
	let relative = path.relative(fromDir, toFile);

	// Remove extension
	relative = relative.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");

	// Ensure ./ prefix for same directory
	if (!relative.startsWith(".")) {
		relative = `./${relative}`;
	}

	return normalizePath(relative);
}

function findMatchingAlias(
	targetPath: string,
	project: ProjectConfig,
): string | null {
	const normalizedTarget = normalizePath(targetPath);

	// Remove extension for matching
	const targetWithoutExt = normalizedTarget.replace(
		/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/,
		"",
	);

	for (const [alias, paths] of project.pathAliases) {
		// Remove trailing /* from alias pattern
		const aliasBase = alias.replace(/\/\*$/, "");

		for (const aliasPath of paths) {
			// Resolve alias path relative to rootDir
			const resolvedAliasPath = path.resolve(
				project.rootDir,
				project.compilerOptions.baseUrl ?? ".",
				aliasPath.replace(/\/\*$/, ""),
			);

			const normalizedAliasPath = normalizePath(resolvedAliasPath);

			// Check if target starts with this alias path
			if (targetWithoutExt.startsWith(normalizedAliasPath)) {
				const remainder = targetWithoutExt.slice(normalizedAliasPath.length);
				return aliasBase + remainder;
			}
		}
	}

	return null;
}

function printResults(
	result: AliasResult,
	dryRun: boolean,
	verbose: boolean,
): void {
	console.log(
		`${dryRun ? "📋 Would update" : "✅ Updated"} ${result.importsUpdated} import(s) in ${result.filesProcessed} file(s)\n`,
	);

	if (verbose || dryRun) {
		// Group changes by file
		const byFile = new Map<string, AliasChange[]>();
		for (const change of result.changes) {
			const existing = byFile.get(change.file) ?? [];
			existing.push(change);
			byFile.set(change.file, existing);
		}

		for (const [file, changes] of byFile) {
			const relativePath = path.relative(process.cwd(), file);
			console.log(`📄 ${relativePath}`);
			for (const change of changes) {
				console.log(`   Line ${change.line}:`);
				console.log(`      - ${change.oldSpecifier}`);
				console.log(`      + ${change.newSpecifier}`);
			}
			console.log();
		}
	}

	if (!dryRun) {
		console.log("✨ Import normalization complete.\n");
	}
}
