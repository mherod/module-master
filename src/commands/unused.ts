import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { filterGitignored } from "../core/git.ts";
import type { DependencyGraph } from "../core/graph.ts";
import { buildDependencyGraph } from "../core/graph.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import { withSourceFile } from "../core/source-file.ts";
import {
	discoverProject,
	toProjectConfig,
} from "../core/tsconfig-discovery.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";

export interface UnusedOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
	ignore?: string;
}

export interface UnusedExport {
	file: string;
	name: string;
	type: ExportInfo["type"];
	isType: boolean;
	line: number;
	/**
	 * True when the export is still referenced within its own file (only the
	 * `export` keyword is redundant). Such a hit is a de-export candidate, not a
	 * delete candidate — removing the symbol would break its own module. False
	 * means the symbol is referenced by no file at all and is safe to delete.
	 */
	internalUsage: boolean;
	/** Number of references to the symbol within its own file (excludes the declaration and export statements). */
	internalRefCount: number;
}

export interface UnusedReport {
	unused: UnusedExport[];
	totalExports: number;
	totalFiles: number;
	/** Exports referenced by no file at all — safe deletion candidates. */
	deadCount: number;
	/** Exports referenced only within their own file — de-export candidates. */
	internalOnlyCount: number;
	/**
	 * Absolute paths of every tsconfig whose files were scanned for usage. Usage
	 * is counted across ALL of these (e.g. a sibling `tsconfig.scripts.json`), so
	 * an export consumed only by a sibling config is not falsely reported dead.
	 */
	scannedConfigs: string[];
	/** Total number of files (across all scanned configs) contributing to the usage graph. */
	scannedFileCount: number;
}

/**
 * Find exports that are never imported by any other file in the project.
 */
export async function findUnusedExports(
	directory: string,
	options?: { project?: string; ignore?: string; workspace?: boolean }
): Promise<UnusedReport> {
	const absoluteDir = path.resolve(directory);

	const tsconfigPath = resolveTsConfig(options?.project, absoluteDir);
	if (!tsconfigPath) {
		return {
			unused: [],
			totalExports: 0,
			totalFiles: 0,
			deadCount: 0,
			internalOnlyCount: 0,
			scannedConfigs: [],
			scannedFileCount: 0,
		};
	}

	// Build the usage graph from EVERY tsconfig discovered in the project, not
	// just the one that resolves for the scan directory. Otherwise an export
	// consumed only by files owned by a sibling config (e.g. a CLI/migration
	// script on tsconfig.scripts.json) is falsely reported dead (#59).
	const graphs = await buildProjectGraphs(tsconfigPath);

	// Merge per-config usage maps and map each file to a graph that contains it
	// (for export scanning + internal-reference counting).
	const importedBindings = new Map<string, Set<string>>();
	const fileToGraph = new Map<string, DependencyGraph>();
	const scannedConfigs: string[] = [];

	for (const { tsconfigPath: configPath, graph } of graphs) {
		scannedConfigs.push(configPath);
		mergeImportedBindings(importedBindings, buildImportedBindingsMap(graph));
		for (const file of graph.imports.keys()) {
			if (!fileToGraph.has(file)) {
				fileToGraph.set(file, graph);
			}
		}
	}

	// Candidate files: those under the target directory, across all configs.
	let candidateFiles = Array.from(fileToGraph.keys()).filter((f) =>
		f.startsWith(absoluteDir)
	);

	// Exclude gitignored files by default
	candidateFiles = await filterGitignored(candidateFiles, absoluteDir);

	// Build ignore pattern. The ignore glob suppresses files as REPORTED
	// CANDIDATES only — ignored files (e.g. tests) still contribute to the usage
	// graph above, so a test-only export is not falsely reported dead.
	const ignorePattern = options?.ignore ? new Bun.Glob(options.ignore) : null;

	const unused: UnusedExport[] = [];
	let totalExports = 0;

	for (const file of candidateFiles) {
		if (
			ignorePattern?.match(file) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}

		const graph = fileToGraph.get(file);
		if (!graph) {
			continue;
		}
		const fileImporters = importedBindings.get(normalizePath(file));

		// Scan exports and count internal references from the same parsed
		// source file, so the cross-file and same-file checks share one parse.
		const collect = (sourceFile: ts.SourceFile): void => {
			const exports = scanExports(sourceFile);
			totalExports += exports.length;

			for (const exp of exports) {
				if (isExportUsed(exp, file, fileImporters, graph)) {
					continue;
				}
				const internalRefCount = countInternalReferences(sourceFile, exp);
				unused.push({
					file,
					name: exp.name,
					type: exp.type,
					isType: exp.isType,
					line: exp.line,
					internalUsage: internalRefCount > 0,
					internalRefCount,
				});
			}
		};

		if (graph.program) {
			withSourceFile(graph.program, file, collect, undefined);
		} else {
			withSourceFile(file, collect, undefined);
		}
	}

	const internalOnlyCount = unused.filter((u) => u.internalUsage).length;

	return {
		unused,
		totalExports,
		totalFiles: candidateFiles.length,
		deadCount: unused.length - internalOnlyCount,
		internalOnlyCount,
		scannedConfigs,
		scannedFileCount: fileToGraph.size,
	};
}

/**
 * Build a dependency graph for every non-solution tsconfig discovered in the
 * project that owns `tsconfigPath`. Falls back to the single resolved config
 * when discovery finds nothing. Each graph is cached per tsconfig by
 * `buildDependencyGraph`, so repeated configs are cheap.
 */
async function buildProjectGraphs(
	tsconfigPath: string
): Promise<{ tsconfigPath: string; graph: DependencyGraph }[]> {
	const discovery = discoverProject(path.dirname(tsconfigPath));
	const configs = discovery.configs.filter((c) => !c.isSolution);

	const projects =
		configs.length > 0
			? configs.map(toProjectConfig)
			: [loadProject(tsconfigPath)];

	const results: { tsconfigPath: string; graph: DependencyGraph }[] = [];
	for (const project of projects) {
		const graph = await buildDependencyGraph(project);
		results.push({ tsconfigPath: project.tsconfigPath, graph });
	}
	return results;
}

/**
 * Merge a per-config imported-bindings map into the accumulating union map.
 * Keys are normalized so the same resolved file from different configs lines up.
 */
function mergeImportedBindings(
	target: Map<string, Set<string>>,
	source: Map<string, Set<string>>
): void {
	for (const [resolvedPath, bindings] of source) {
		const key = normalizePath(resolvedPath);
		const existing = target.get(key);
		if (existing) {
			for (const binding of bindings) {
				existing.add(binding);
			}
		} else {
			target.set(key, new Set(bindings));
		}
	}
}

/**
 * Count references to an exported symbol within its own defining file,
 * excluding the declaration itself and the export statements that surface it.
 *
 * A positive count means the symbol is consumed inside its own module: only the
 * `export` keyword is redundant (a de-export candidate). A zero count means the
 * symbol is referenced by no file at all and is safe to delete.
 *
 * Uses a name-based AST walk rather than the type checker so it stays
 * unit-testable against a standalone `ts.SourceFile`. Ambiguous matches (e.g. a
 * shadowing local of the same name) are counted as usage, which biases toward
 * the safe "verify before deleting" direction.
 */
export function countInternalReferences(
	sourceFile: ts.SourceFile,
	exp: ExportInfo
): number {
	let count = 0;

	// Parent is tracked explicitly through the walk rather than read from
	// `node.parent`: source files obtained from a ts.Program are not bound until
	// the type checker runs, so their parent pointers may be undefined.
	const isDeclarationName = (node: ts.Identifier, parent: ts.Node): boolean =>
		(ts.isFunctionDeclaration(parent) && parent.name === node) ||
		(ts.isClassDeclaration(parent) && parent.name === node) ||
		(ts.isInterfaceDeclaration(parent) && parent.name === node) ||
		(ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
		(ts.isEnumDeclaration(parent) && parent.name === node) ||
		(ts.isVariableDeclaration(parent) && parent.name === node) ||
		(ts.isParameter(parent) && parent.name === node) ||
		(ts.isBindingElement(parent) && parent.name === node);

	// Property/member positions (`obj.name`, `{ name: ... }`, `Ns.name`) are not
	// references to the exported symbol.
	const isMemberName = (node: ts.Identifier, parent: ts.Node): boolean =>
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		(ts.isQualifiedName(parent) && parent.right === node) ||
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isPropertySignature(parent) && parent.name === node) ||
		(ts.isMethodDeclaration(parent) && parent.name === node) ||
		(ts.isMethodSignature(parent) && parent.name === node);

	// The export statement itself (`export { name }`, `export default name`) is
	// not internal usage — it is the redundant re-export we are flagging.
	const isExportName = (node: ts.Identifier, parent: ts.Node): boolean =>
		ts.isExportSpecifier(parent) ||
		(ts.isExportAssignment(parent) && parent.expression === node);

	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (
			ts.isIdentifier(node) &&
			node.text === exp.name &&
			!isDeclarationName(node, parent) &&
			!isMemberName(node, parent) &&
			!isExportName(node, parent)
		) {
			count++;
		}
		ts.forEachChild(node, (child) => visit(child, node));
	};

	ts.forEachChild(sourceFile, (child) => visit(child, sourceFile));
	return count;
}

/**
 * Build a map from resolved file path to the set of binding names imported from it.
 * Also tracks wildcard imports (import *, export *) as a special "__all__" entry.
 */
export function buildImportedBindingsMap(
	graph: DependencyGraph
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();

	for (const refs of graph.imports.values()) {
		for (const ref of refs) {
			const resolved = ref.resolvedPath;
			if (!map.has(resolved)) {
				map.set(resolved, new Set());
			}
			const bindings = map.get(resolved);
			if (!bindings) {
				continue;
			}

			switch (ref.type) {
				case "import":
				case "export-all":
				case "export-all-as":
				case "import-namespace":
				case "import-side-effect":
				case "import-dynamic":
				case "require":
				case "require-resolve":
				case "jest-mock":
					// These consume the entire module
					bindings.add("__all__");
					break;
				case "import-named":
				case "export-from":
					if (ref.bindings) {
						for (const b of ref.bindings) {
							bindings.add(b.name);
						}
					}
					break;
				default:
					break;
			}
		}
	}

	return map;
}

/**
 * Check whether an export is consumed anywhere in the project.
 */
export function isExportUsed(
	exp: ExportInfo,
	_file: string,
	fileImporters: Set<string> | undefined,
	_graph: DependencyGraph
): boolean {
	if (!fileImporters) {
		return false;
	}

	// If anyone does import *, export *, require, dynamic import — all exports are used
	if (fileImporters.has("__all__")) {
		return true;
	}

	// Default exports are imported as the default binding
	if (exp.type === "default") {
		return fileImporters.has("default");
	}

	// Named exports are matched by name
	return fileImporters.has(exp.name);
}

export async function unusedCommand(options: UnusedOptions): Promise<void> {
	const { directory, json, verbose, ignore } = options;
	const absoluteDir = path.resolve(directory);

	if (!json) {
		logger.info(`\n🔍 Scanning for unused exports in ${absoluteDir}\n`);
	}

	const report = await findUnusedExports(directory, {
		project: options.project,
		ignore,
		workspace: options.workspace,
	});

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	logger.info(
		`📊 Scanned ${report.totalExports} export(s) across ${report.totalFiles} file(s)\n`
	);

	if (report.unused.length === 0) {
		logger.info("✅ No unused exports found.");
		logger.empty();
		return;
	}

	// Group by file
	const byFile = new Map<string, UnusedExport[]>();
	for (const u of report.unused) {
		const existing = byFile.get(u.file) ?? [];
		existing.push(u);
		byFile.set(u.file, existing);
	}

	logger.info(
		`Found ${report.unused.length} unused export(s) in ${byFile.size} file(s):`
	);
	logger.info(
		`  ${report.deadCount} referenced nowhere (safe to delete) · ${report.internalOnlyCount} referenced only within their own file (de-export candidates)\n`
	);

	for (const [file, exports] of byFile) {
		const rel = path.relative(absoluteDir, file);
		logger.info(`  ${rel}`);
		for (const exp of exports) {
			const typeLabel = exp.isType ? " (type)" : "";
			const usageLabel = exp.internalUsage
				? ` — used internally ×${exp.internalRefCount}, de-export not delete`
				: " — no references, safe to delete";
			logger.info(
				`    • ${exp.name}${typeLabel} (line ${exp.line})${usageLabel}`
			);
		}
		if (verbose) {
			logger.empty();
		}
	}

	logger.info(
		`\n${report.unused.length} unused export(s) in ${byFile.size} file(s) — ${report.deadCount} deletable, ${report.internalOnlyCount} de-export only`
	);
	logger.empty();
}
