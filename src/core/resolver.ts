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
		const updated = updateAliasedSpecifier(
			oldSpecifier,
			aliasMatch,
			oldTargetPath,
			newTargetPath,
			fromFile,
			project,
		);
		// If updateAliasedSpecifier couldn't map to the same alias,
		// try to find a different alias that covers the new target
		if (updated.startsWith("../") || updated.startsWith("./")) {
			const crossPackageAlias = findAliasForPath(newTargetPath, project);
			if (crossPackageAlias) {
				return crossPackageAlias;
			}
		}
		return updated;
	}

	// For relative imports, try to find an alias first (for cross-package moves)
	if (isRelativeImport(oldSpecifier)) {
		const crossPackageAlias = findAliasForPath(newTargetPath, project);
		if (crossPackageAlias) {
			return crossPackageAlias;
		}
		return calculateRelativeSpecifier(fromFile, newTargetPath);
	}

	// For bare specifiers (packages), return unchanged
	return oldSpecifier;
}

/**
 * Find a path alias that can be used to import the given absolute file path
 */
export function findAliasForPath(
	targetPath: string,
	project: ProjectConfig,
): string | null {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedTarget = normalizePath(targetPath);

	// Try each path alias to see if it covers the target
	// Prioritize wildcard aliases over exact matches for paths with subpaths
	const candidates: Array<{ alias: string; result: string; isWildcard: boolean }> = [];

	for (const [alias, paths] of project.pathAliases) {
		const isWildcard = alias.endsWith("/*");

		for (const pathPattern of paths) {
			const resolvedPattern = pathPattern.endsWith("/*")
				? pathPattern.slice(0, -1)
				: pathPattern;

			const absolutePattern = normalizePath(path.resolve(baseUrl, resolvedPattern));

			if (normalizedTarget.startsWith(absolutePattern)) {
				const remainder = normalizedTarget
					.slice(absolutePattern.length)
					.replace(/\.[tj]sx?$/, ""); // Remove extension

				// For wildcard aliases, use them if there's a remainder
				// For exact aliases, only use if there's NO remainder (exact match)
				if (isWildcard && remainder) {
					const aliasPrefix = alias.slice(0, -1); // Remove /*
					candidates.push({
						alias,
						result: aliasPrefix + remainder,
						isWildcard: true,
					});
				} else if (!isWildcard && !remainder) {
					// Exact match - target is exactly at the alias root
					candidates.push({
						alias,
						result: alias,
						isWildcard: false,
					});
				}
			}
		}
	}

	// Prefer wildcard matches over exact matches (more specific)
	const wildcardMatch = candidates.find((c) => c.isWildcard);
	if (wildcardMatch) {
		return wildcardMatch.result;
	}

	const exactMatch = candidates.find((c) => !c.isWildcard);
	if (exactMatch) {
		return exactMatch.result;
	}

	return null;
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
	fromFile: string,
	project: ProjectConfig,
): string {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedNewTarget = normalizePath(newTargetPath);

	// Find which path pattern matched the old target
	for (const pathPattern of aliasMatch.paths) {
		const resolvedPattern = pathPattern.endsWith("/*")
			? pathPattern.slice(0, -1)
			: pathPattern;

		const absolutePattern = normalizePath(path.resolve(baseUrl, resolvedPattern));

		if (oldTargetPath.startsWith(absolutePattern)) {
			// Check if the NEW target is ALSO within this alias scope
			if (normalizedNewTarget.startsWith(absolutePattern)) {
				// New target is in the same alias scope - update the remainder
				const newRemainder = normalizedNewTarget
					.slice(absolutePattern.length)
					.replace(/\.[tj]sx?$/, ""); // Remove extension

				const aliasPrefix = aliasMatch.alias.endsWith("/*")
					? aliasMatch.alias.slice(0, -1)
					: aliasMatch.alias;

				return aliasPrefix + newRemainder;
			}
			// New target is OUTSIDE this alias scope - need a different approach
			break;
		}
	}

	// The new target is not in the same alias scope
	// Try to find a different alias that covers the new location
	const crossPackageAlias = findAliasForPath(newTargetPath, project);
	if (crossPackageAlias) {
		return crossPackageAlias;
	}

	// Last resort: fall back to relative path from the importing file
	return calculateRelativeSpecifier(fromFile, newTargetPath);
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
