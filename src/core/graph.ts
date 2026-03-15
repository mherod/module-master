import type { BarrelExport, ModuleReference, ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import { createProgram, getProjectFiles } from "./project.ts";
import { normalizePath } from "./resolver.ts";
import {
	scanBarrelExports,
	scanModuleReferences,
	withSourceFile,
} from "./scanner.ts";

export interface DependencyGraph {
	/** Map from file path to files it imports */
	imports: Map<string, ModuleReference[]>;
	/** Map from file path to files that import it */
	importedBy: Map<string, ModuleReference[]>;
	/** Set of barrel files (index.ts that re-export) */
	barrelFiles: Set<string>;
	/** Map from barrel file to the files it actually re-exports (export ... from) */
	barrelReExports: Map<string, string[]>;
}

interface FileScanResult {
	normalizedFile: string;
	refs: ModuleReference[];
	barrels: BarrelExport[];
}

/**
 * Build a complete dependency graph for the project
 */
export async function buildDependencyGraph(
	project: ProjectConfig
): Promise<DependencyGraph> {
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

	return { imports, importedBy, barrelFiles, barrelReExports };
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
