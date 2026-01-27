import path from "node:path";
import ts from "typescript";
import type { ProjectConfig } from "../types.ts";

/**
 * Resolve a module specifier to an absolute file path
 */
export function resolveModulePath(
	specifier: string,
	fromFile: string,
	project: ProjectConfig,
): string | null {
	const result = ts.resolveModuleName(
		specifier,
		fromFile,
		project.compilerOptions,
		ts.sys,
	);

	if (result.resolvedModule) {
		return result.resolvedModule.resolvedFileName;
	}

	return null;
}

/**
 * Calculate the new import specifier after a file move
 */
export function calculateNewSpecifier(
	oldSpecifier: string,
	fromFile: string,
	oldTargetPath: string,
	newTargetPath: string,
	project: ProjectConfig,
): string {
	// If it's a path alias, check if we should preserve it or update it
	const aliasMatch = matchPathAlias(oldSpecifier, project);
	if (aliasMatch) {
		return updateAliasedSpecifier(
			oldSpecifier,
			aliasMatch,
			oldTargetPath,
			newTargetPath,
			project,
		);
	}

	// For relative imports, calculate new relative path
	if (isRelativeImport(oldSpecifier)) {
		return calculateRelativeSpecifier(fromFile, newTargetPath);
	}

	// For bare specifiers (packages), return unchanged
	return oldSpecifier;
}

/**
 * Check if a specifier matches any path alias
 */
export function matchPathAlias(
	specifier: string,
	project: ProjectConfig,
): { alias: string; paths: string[]; remainder: string } | null {
	for (const [alias, paths] of project.pathAliases) {
		// Handle exact matches and wildcard patterns
		if (alias.endsWith("/*")) {
			const prefix = alias.slice(0, -1); // Remove trailing *
			if (specifier.startsWith(prefix)) {
				return {
					alias,
					paths,
					remainder: specifier.slice(prefix.length),
				};
			}
		} else if (specifier === alias) {
			return { alias, paths, remainder: "" };
		}
	}

	return null;
}

/**
 * Update an aliased import specifier after a file move
 */
function updateAliasedSpecifier(
	_oldSpecifier: string,
	aliasMatch: { alias: string; paths: string[]; remainder: string },
	oldTargetPath: string,
	newTargetPath: string,
	project: ProjectConfig,
): string {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;

	// Find which path pattern matched the old target
	for (const pathPattern of aliasMatch.paths) {
		const resolvedPattern = pathPattern.endsWith("/*")
			? pathPattern.slice(0, -1)
			: pathPattern;

		const absolutePattern = path.resolve(baseUrl, resolvedPattern);

		if (oldTargetPath.startsWith(absolutePattern)) {
			// Calculate new remainder based on new target path
			const newRemainder = newTargetPath
				.slice(absolutePattern.length)
				.replace(/\.[tj]sx?$/, ""); // Remove extension

			const aliasPrefix = aliasMatch.alias.endsWith("/*")
				? aliasMatch.alias.slice(0, -1)
				: aliasMatch.alias;

			return aliasPrefix + newRemainder;
		}
	}

	// If we can't map it back to the same alias, fall back to relative
	return calculateRelativeSpecifier(project.rootDir, newTargetPath);
}

/**
 * Calculate a relative import specifier from one file to another
 */
export function calculateRelativeSpecifier(
	fromFile: string,
	toFile: string,
): string {
	const fromDir = path.dirname(fromFile);
	let relativePath = path.relative(fromDir, toFile);

	// Remove extension
	relativePath = relativePath.replace(/\.[tj]sx?$/, "");

	// Handle index files
	if (relativePath.endsWith("/index") || relativePath === "index") {
		relativePath = relativePath.replace(/\/?index$/, "") || ".";
	}

	// Ensure it starts with ./ or ../
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`;
	}

	return relativePath;
}

/**
 * Check if a specifier is a relative import
 */
export function isRelativeImport(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Check if a specifier is a bare/package import
 */
export function isBareImport(specifier: string): boolean {
	return !isRelativeImport(specifier) && !path.isAbsolute(specifier);
}

/**
 * Normalize a file path (resolve symlinks, normalize slashes)
 */
export function normalizePath(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, "/");
}
