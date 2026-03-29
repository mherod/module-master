import path from "node:path";
import { logger } from "../cli-logger.ts";
import { filterGitignored } from "../core/git.ts";
import type { DependencyGraph } from "../core/graph.ts";
import { buildDependencyGraph } from "../core/graph.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { scanExports } from "../core/scanner.ts";
import { withSourceFile } from "../core/source-file.ts";
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
}

export interface UnusedReport {
	unused: UnusedExport[];
	totalExports: number;
	totalFiles: number;
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
		return { unused: [], totalExports: 0, totalFiles: 0 };
	}

	const project = loadProject(tsconfigPath);
	const graph = await buildDependencyGraph(project);

	// Filter graph files to those under the target directory
	let allFiles = Array.from(graph.imports.keys()).filter((f) =>
		f.startsWith(absoluteDir)
	);

	// Exclude gitignored files by default
	allFiles = await filterGitignored(allFiles, absoluteDir);

	// Build a set of all imported bindings: Map<resolvedPath, Set<bindingName>>
	const importedBindings = buildImportedBindingsMap(graph);

	// Build ignore pattern
	const ignorePattern = options?.ignore ? new Bun.Glob(options.ignore) : null;

	const unused: UnusedExport[] = [];
	let totalExports = 0;

	for (const file of allFiles) {
		if (
			ignorePattern?.match(file) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}

		const exports = graph.program
			? withSourceFile(graph.program, file, scanExports, [] as ExportInfo[])
			: withSourceFile(file, scanExports, [] as ExportInfo[]);

		totalExports += exports.length;

		const fileImporters = importedBindings.get(file);

		for (const exp of exports) {
			if (isExportUsed(exp, file, fileImporters, graph)) {
				continue;
			}
			unused.push({
				file,
				name: exp.name,
				type: exp.type,
				isType: exp.isType,
				line: exp.line,
			});
		}
	}

	return { unused, totalExports, totalFiles: allFiles.length };
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
		`Found ${report.unused.length} unused export(s) in ${byFile.size} file(s):\n`
	);

	for (const [file, exports] of byFile) {
		const rel = path.relative(absoluteDir, file);
		logger.info(`  ${rel}`);
		for (const exp of exports) {
			const typeLabel = exp.isType ? " (type)" : "";
			logger.info(`    • ${exp.name}${typeLabel} (line ${exp.line})`);
		}
		if (verbose) {
			logger.empty();
		}
	}

	logger.info(
		`\n${report.unused.length} unused export(s) in ${byFile.size} file(s)`
	);
	logger.empty();
}
