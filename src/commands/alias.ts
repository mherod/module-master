import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import {
	calculateRelativeSpecifier,
	findAliasForPath,
} from "../core/resolver.ts";
import { scanModuleReferences } from "../core/scanner.ts";
import {
	printVerificationResults,
	verifyTypeChecking,
} from "../core/verify.ts";
import type { ModuleReference, ProjectConfig } from "../types.ts";

export interface AliasOptions {
	target: string;
	prefer: "alias" | "relative" | "shortest";
	dryRun?: boolean;
	verbose?: boolean;
	verify?: boolean;
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
		verify = true,
		project: projectArg,
	} = options;

	const absoluteTarget = path.resolve(target);

	// Find and load project config
	const tsconfigPath = resolveTsConfig(projectArg, absoluteTarget);
	if (!tsconfigPath) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath);

	logger.info(`\n${dryRun ? "🔍 Dry run:" : "🔧"} Normalizing imports...`);
	logger.info(`   Target: ${absoluteTarget}`);
	logger.info(`   Strategy: ${prefer}`);
	if (verify) {
		logger.info("   Verification: enabled");
	}
	logger.empty();

	const result = await normalizeImports(absoluteTarget, prefer, project);

	if (result.changes.length === 0) {
		logger.info(
			"✨ No changes needed. All imports already follow the preferred style.\n"
		);
		return;
	}

	// Apply changes with optional verification
	if (dryRun) {
		printResults(result, dryRun, verbose);
	} else if (verify) {
		const verifyResult = await verifyTypeChecking(
			project,
			() => {
				// No snapshot needed
			},
			() => applyChanges(result.changes)
		);

		printResults(result, dryRun, verbose);
		logger.empty();
		printVerificationResults(verifyResult);

		if (!verifyResult.success) {
			logger.error(
				"\n⚠️  Type checking failed. Changes were applied but introduced errors."
			);
			process.exit(1);
		}
	} else {
		applyChanges(result.changes);
		printResults(result, dryRun, verbose);
	}
}

async function normalizeImports(
	target: string,
	prefer: "alias" | "relative" | "shortest",
	project: ProjectConfig
): Promise<AliasResult> {
	const changes: AliasChange[] = [];
	const skipped: AliasChange[] = [];
	const filesToProcess = getFilesToProcess(target, project);

	for (const file of filesToProcess) {
		const references = await getFileReferences(file, project);

		// Build a set of existing specifiers and their bindings in this file
		const existingSpecifiers = new Map<string, Set<string>>();
		for (const ref of references) {
			const bindings = existingSpecifiers.get(ref.specifier) ?? new Set();
			if (ref.bindings) {
				for (const b of ref.bindings) {
					bindings.add(b.alias ?? b.name);
				}
			}
			existingSpecifiers.set(ref.specifier, bindings);
		}

		for (const ref of references) {
			// Skip external packages (node_modules, built-in modules)
			if (
				!ref.resolvedPath.includes(project.rootDir) ||
				ref.resolvedPath.includes("node_modules")
			) {
				continue;
			}

			const newSpecifier = calculatePreferredSpecifier(
				file,
				ref.resolvedPath,
				prefer,
				project
			);

			if (newSpecifier && newSpecifier !== ref.specifier) {
				// Check for duplicate specifier conflict: would the new specifier
				// collide with an existing import that has overlapping bindings?
				const existingBindings = existingSpecifiers.get(newSpecifier);
				if (existingBindings && ref.bindings) {
					const overlapping = ref.bindings.some((b) =>
						existingBindings.has(b.alias ?? b.name)
					);
					if (overlapping) {
						skipped.push({
							file,
							line: ref.line,
							oldSpecifier: ref.specifier,
							newSpecifier,
							strategy: prefer,
						});
						continue;
					}
				}

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

	if (skipped.length > 0) {
		logger.info(
			`⚠️  Skipped ${skipped.length} import(s) to avoid binding conflicts:`
		);
		for (const change of skipped) {
			const relativePath = path.relative(process.cwd(), change.file);
			logger.info(
				`   ${relativePath}:${change.line}: "${change.oldSpecifier}" → "${change.newSpecifier}" would duplicate a binding`
			);
		}
		logger.empty();
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
		if (!content) {
			continue;
		}

		// Sort changes by line number (descending) to avoid offset issues
		const sorted = [...fileChanges].sort((a, b) => b.line - a.line);

		// Apply each change
		for (const change of sorted) {
			// Simple string replacement approach
			// This works for most cases, but could be improved with AST-based replacement
			const oldImport = new RegExp(
				`(['"\`])${escapeRegex(change.oldSpecifier)}\\1`,
				"g"
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
	if (ts.sys.fileExists(target)) {
		return [target];
	}

	if (ts.sys.directoryExists(target)) {
		return project.files.filter((f) => f.startsWith(target));
	}

	return [];
}

async function getFileReferences(
	filePath: string,
	project: ProjectConfig
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
	project: ProjectConfig
): string | null {
	const relativeSpecifier = calculateRelativeSpecifier(fromFile, toFile);
	const aliasSpecifier = findAliasForPath(toFile, project);

	if (prefer === "relative") {
		return relativeSpecifier;
	}

	if (prefer === "alias") {
		return aliasSpecifier ?? relativeSpecifier;
	}

	if (prefer === "shortest") {
		if (!aliasSpecifier) {
			return relativeSpecifier;
		}
		return relativeSpecifier.length <= aliasSpecifier.length
			? relativeSpecifier
			: aliasSpecifier;
	}

	return null;
}

function printResults(
	result: AliasResult,
	dryRun: boolean,
	verbose: boolean
): void {
	logger.info(
		`${dryRun ? "📋 Would update" : "✅ Updated"} ${result.importsUpdated} import(s) in ${result.filesProcessed} file(s)\n`
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
			logger.info(`📄 ${relativePath}`);
			for (const change of changes) {
				logger.info(`   Line ${change.line}:`);
				logger.info(`      - ${change.oldSpecifier}`);
				logger.info(`      + ${change.newSpecifier}`);
			}
			logger.empty();
		}
	}

	if (!dryRun) {
		logger.info("✨ Import normalization complete.\n");
	}
}
