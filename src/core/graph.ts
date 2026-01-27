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

	for (const file of files) {
		const sourceFile = program.getSourceFile(file);
		if (!sourceFile) continue;

		const normalizedFile = normalizePath(file);
		const refs = scanModuleReferences(sourceFile, project);
		imports.set(normalizedFile, refs);

		// Check if this is a barrel file
		const barrels = scanBarrelExports(sourceFile, project);
		if (barrels.length > 0) {
			barrelFiles.add(normalizedFile);
		}

		// Populate reverse mapping
		for (const ref of refs) {
			const normalizedResolved = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(normalizedResolved) ?? [];
			existing.push(ref);
			importedBy.set(normalizedResolved, existing);
		}
	}

	return { imports, importedBy, barrelFiles };
}

/**
 * Find all files that reference a given file (directly or through barrels)
 */
export function findAllReferences(
	filePath: string,
	graph: DependencyGraph,
	_project?: ProjectConfig,
): ModuleReference[] {
	const normalizedPath = normalizePath(filePath);
	const directRefs = graph.importedBy.get(normalizedPath) ?? [];

	// Also find references through barrel files
	const barrelRefs: ModuleReference[] = [];

	for (const barrelPath of graph.barrelFiles) {
		const barrelImports = graph.imports.get(barrelPath) ?? [];
		const reExportsTarget = barrelImports.some(
			(ref) => normalizePath(ref.resolvedPath) === normalizedPath,
		);

		if (reExportsTarget) {
			// This barrel re-exports our target file
			// Find everyone who imports from this barrel
			const barrelConsumers = graph.importedBy.get(barrelPath) ?? [];
			barrelRefs.push(
				...barrelConsumers.map((ref) => ({
					...ref,
					// Mark that this is an indirect reference through a barrel
					resolvedPath: normalizedPath,
				})),
			);
		}
	}

	return [...directRefs, ...barrelRefs];
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
		const barrelImports = graph.imports.get(barrelPath) ?? [];
		const reExportsTarget = barrelImports.some(
			(ref) => normalizePath(ref.resolvedPath) === normalizedPath,
		);

		if (reExportsTarget) {
			barrels.push(barrelPath);
		}
	}

	return barrels;
}
