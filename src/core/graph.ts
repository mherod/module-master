import type { ModuleReference, ProjectConfig } from "../types.ts";
import { createProgram, getProjectFiles } from "./project.ts";
import { normalizePath } from "./resolver.ts";
import { scanBarrelExports, scanModuleReferences } from "./scanner.ts";

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

/**
 * Build a complete dependency graph for the project
 */
export function buildDependencyGraph(project: ProjectConfig): DependencyGraph {
	const files = getProjectFiles(project);
	const program = createProgram(project, files);

	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();

	for (const file of files) {
		const sourceFile = program.getSourceFile(file);
		if (!sourceFile) continue;

		const normalizedFile = normalizePath(file);
		const refs = scanModuleReferences(sourceFile, project);
		imports.set(normalizedFile, refs);

		// Check if this is a barrel file and track what it re-exports
		const barrels = scanBarrelExports(sourceFile, project);
		if (barrels.length > 0) {
			barrelFiles.add(normalizedFile);
			// Store the actual files this barrel re-exports
			const reExportedFiles = barrels.map((b) => normalizePath(b.resolvedPath));
			barrelReExports.set(normalizedFile, reExportedFiles);
		}

		// Populate reverse mapping
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
	graph: DependencyGraph,
	_project?: ProjectConfig,
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
			if (visitedBarrels.has(barrelPath)) continue;

			// Does this barrel re-export anything we're already tracking?
			// (e.g. re-exports target directly, or re-exports a barrel that re-exports target)
			const reExportsTarget = reExports.some((exportedFile) =>
				reExportingFiles.has(exportedFile),
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
			if (seenRefs.has(key)) continue;
			seenRefs.add(key);

			// If referring to a barrel, update resolvedPath to point to original target
			// so updater knows this effectively imports the target
			if (exportedFile !== normalizedPath) {
				allRefs.push({
					...ref,
					resolvedPath: normalizedPath,
				});
			} else {
				// Direct reference
				allRefs.push(ref);
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
	graph: DependencyGraph,
): ModuleReference[] {
	return graph.imports.get(normalizePath(filePath)) ?? [];
}

/**
 * Check if a file is a barrel file
 */
export function isBarrelFile(
	filePath: string,
	graph: DependencyGraph,
): boolean {
	return graph.barrelFiles.has(normalizePath(filePath));
}

/**
 * Find barrel files that re-export a given file
 */
export function findBarrelReExports(
	filePath: string,
	graph: DependencyGraph,
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
