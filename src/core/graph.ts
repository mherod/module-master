import path from "node:path";
import type ts from "typescript";
import type { BarrelExport, ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import { createProgram, getProjectFiles, loadProject } from "./project.ts";
import { normalizePath } from "./resolver.ts";
import { scanBarrelExports, scanModuleReferences } from "./scanner.ts";
import { withSourceFile } from "./source-file.ts";
import { discoverProject, toProjectConfig } from "./tsconfig-discovery.ts";

/**
 * Run `callback` with the parsed source file for `filePath` from the
 * graph's program(s). Tries `graph.program` first, then any program in
 * `graph.programs` (covers workspace-merged graphs), then returns
 * `fallback` if no program owns the file. Zero disk I/O.
 */
export function withGraphSourceFile<T>(
	graph: Pick<DependencyGraph, "program" | "programs">,
	filePath: string,
	callback: (sourceFile: ts.SourceFile) => T,
	fallback: T
): T {
	const primary = graph.program?.getSourceFile(filePath);
	if (primary) {
		return callback(primary);
	}
	for (const p of graph.programs ?? []) {
		const sf = p.getSourceFile(filePath);
		if (sf) {
			return callback(sf);
		}
	}
	return fallback;
}

export interface DependencyGraph {
	/** Map from file path to files it imports */
	imports: Map<string, ModuleReference[]>;
	/** Map from file path to files that import it */
	importedBy: Map<string, ModuleReference[]>;
	/** Set of barrel files (index.ts that re-export) */
	barrelFiles: Set<string>;
	/** Map from barrel file to the files it actually re-exports (export ... from) */
	barrelReExports: Map<string, string[]>;
	/** The TypeScript program used to build this graph — enables zero-disk-I/O source file access.
	 * Absent on test-constructed graphs. */
	program?: ts.Program;
	/** Additional programs covering files outside `program` (e.g. workspace-merged graphs).
	 * Callers should look up a file in `program` first, then fall back to scanning `programs`. */
	programs?: ts.Program[];
}

interface FileScanResult {
	normalizedFile: string;
	refs: ModuleReference[];
	barrels: BarrelExport[];
}

/** Per-invocation cache for dependency graphs, keyed by tsconfig path */
const graphCache = new Map<string, DependencyGraph>();

/**
 * Build a complete dependency graph for the project.
 * Results are cached per tsconfig path for the lifetime of the process.
 */
export async function buildDependencyGraph(
	project: ProjectConfig
): Promise<DependencyGraph> {
	const cached = graphCache.get(project.tsconfigPath);
	if (cached) {
		return cached;
	}
	const files = getProjectFiles(project);
	const program = createProgram(project, files);

	// Scan all files concurrently — each scan is independent
	const scanResults = await mapConcurrent(
		files,
		async (file) =>
			withSourceFile(
				program,
				file,
				(sourceFile): FileScanResult => ({
					normalizedFile: normalizePath(file),
					refs: scanModuleReferences(sourceFile, project),
					barrels: scanBarrelExports(sourceFile, project),
				}),
				null
			),
		{ onError: () => null }
	);

	// Merge results sequentially (shared mutable maps)
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();

	for (const result of scanResults) {
		if (!result) {
			continue;
		}
		const { normalizedFile, refs, barrels } = result;
		imports.set(normalizedFile, refs);

		if (barrels.length > 0) {
			barrelFiles.add(normalizedFile);
			const reExportedFiles = barrels.map((b) => normalizePath(b.resolvedPath));
			barrelReExports.set(normalizedFile, reExportedFiles);
		}

		for (const ref of refs) {
			const normalizedResolved = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(normalizedResolved) ?? [];
			existing.push(ref);
			importedBy.set(normalizedResolved, existing);
		}
	}

	const result: DependencyGraph = {
		imports,
		importedBy,
		barrelFiles,
		barrelReExports,
		program,
	};
	graphCache.set(project.tsconfigPath, result);
	return result;
}

/**
 * Find all files that reference a given file (directly or through barrels)
 * recursing up through chain of re-exports
 */
export function findAllReferences(
	filePath: string,
	graph: DependencyGraph
): ModuleReference[] {
	const normalizedPath = normalizePath(filePath);

	// Track files that effectively represent the target module
	// Starts with the module itself, adds barrels that re-export it
	const reExportingFiles = new Set<string>([normalizedPath]);
	const visitedBarrels = new Set<string>();

	// Iteratively find all barrels that re-export our target or its re-exporters
	let changed = true;
	while (changed) {
		changed = false;
		for (const [barrelPath, reExports] of graph.barrelReExports) {
			if (visitedBarrels.has(barrelPath)) {
				continue;
			}

			// Does this barrel re-export anything we're already tracking?
			// (e.g. re-exports target directly, or re-exports a barrel that re-exports target)
			const reExportsTarget = reExports.some((exportedFile) =>
				reExportingFiles.has(exportedFile)
			);

			if (reExportsTarget) {
				reExportingFiles.add(barrelPath);
				visitedBarrels.add(barrelPath);
				changed = true;
			}
		}
	}

	const allRefs: ModuleReference[] = [];
	const seenRefs = new Set<string>(); // avoid duplicates

	// Collect references to any file in the re-export chain
	for (const exportedFile of reExportingFiles) {
		const consumers = graph.importedBy.get(exportedFile) ?? [];

		for (const ref of consumers) {
			// Create unique key for deduping (file + specifier + line)
			const key = `${ref.sourceFile}:${ref.specifier}:${ref.line}`;
			if (seenRefs.has(key)) {
				continue;
			}
			seenRefs.add(key);

			// If referring to a barrel, update resolvedPath to point to original target
			// so updater knows this effectively imports the target
			if (exportedFile === normalizedPath) {
				// Direct reference
				allRefs.push(ref);
			} else {
				allRefs.push({
					...ref,
					resolvedPath: normalizedPath,
				});
			}
		}
	}

	return allRefs;
}

/**
 * Get all files that a given file imports
 */
export function getImports(
	filePath: string,
	graph: DependencyGraph
): ModuleReference[] {
	return graph.imports.get(normalizePath(filePath)) ?? [];
}

/**
 * Check if a file is a barrel file
 */
export function isBarrelFile(
	filePath: string,
	graph: DependencyGraph
): boolean {
	return graph.barrelFiles.has(normalizePath(filePath));
}

/**
 * Find barrel files that re-export a given file
 */
export function findBarrelReExports(
	filePath: string,
	graph: DependencyGraph
): string[] {
	const normalizedPath = normalizePath(filePath);
	const barrels: string[] = [];

	for (const barrelPath of graph.barrelFiles) {
		// Use barrelReExports to check actual re-exports, not just imports
		const reExportedFiles = graph.barrelReExports.get(barrelPath) ?? [];
		if (reExportedFiles.includes(normalizedPath)) {
			barrels.push(barrelPath);
		}
	}

	return barrels;
}

/**
 * Build a dependency graph for every non-solution tsconfig discovered in the
 * project that owns `tsconfigPath`. Falls back to the single resolved config
 * when discovery finds nothing. Each graph is cached per tsconfig by
 * `buildDependencyGraph`, so repeated configs are cheap.
 *
 * Use this anywhere a command needs to see references that live in sibling
 * tsconfigs (e.g. analyze, unused) — querying a single graph misses files
 * owned by other configs in the same project (#59 / #66).
 */
export async function buildProjectGraphs(
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
 * Union multiple per-tsconfig dependency graphs into a single graph suitable
 * for cross-config reverse-reference queries (`findAllReferences`,
 * `findBarrelReExports`). All maps are deep-merged; per-ref duplicates are
 * deduped by `sourceFile:specifier:line` so a shared file appearing in two
 * configs does not double-count.
 *
 * The first graph's `program` is preserved as `program` for zero-I/O lookups;
 * remaining programs are collected into `programs` so `withGraphSourceFile`
 * can still find a source file owned by any contributing config.
 */
export function mergeDependencyGraphs(
	graphs: DependencyGraph[]
): DependencyGraph {
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();
	const programs: ts.Program[] = [];

	const refKey = (r: ModuleReference) =>
		`${r.sourceFile}:${r.specifier}:${r.line}`;

	const mergeRefMap = (
		target: Map<string, ModuleReference[]>,
		source: Map<string, ModuleReference[]>
	) => {
		for (const [key, refs] of source) {
			const existing = target.get(key);
			if (existing) {
				const seen = new Set(existing.map(refKey));
				for (const ref of refs) {
					const k = refKey(ref);
					if (!seen.has(k)) {
						existing.push(ref);
						seen.add(k);
					}
				}
			} else {
				target.set(key, [...refs]);
			}
		}
	};

	for (const g of graphs) {
		mergeRefMap(imports, g.imports);
		mergeRefMap(importedBy, g.importedBy);
		for (const b of g.barrelFiles) {
			barrelFiles.add(b);
		}
		for (const [barrel, files] of g.barrelReExports) {
			const existing = barrelReExports.get(barrel) ?? [];
			for (const f of files) {
				if (!existing.includes(f)) {
					existing.push(f);
				}
			}
			barrelReExports.set(barrel, existing);
		}
		if (g.program) {
			programs.push(g.program);
		}
		if (g.programs) {
			programs.push(...g.programs);
		}
	}

	const [primary, ...rest] = programs;
	return {
		imports,
		importedBy,
		barrelFiles,
		barrelReExports,
		program: primary,
		programs: rest.length > 0 ? rest : undefined,
	};
}
