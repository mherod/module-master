import path from "node:path";
import ts from "typescript";
import type { ProjectConfig } from "../types.ts";
import type { WorkspaceInfo } from "./workspace.ts";

/**
 * Resolve a module specifier to an absolute file path
 */
export function resolveModulePath(
	specifier: string,
	fromFile: string,
	project: ProjectConfig
): string | null {
	const result = ts.resolveModuleName(
		specifier,
		fromFile,
		project.compilerOptions,
		ts.sys
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
	project: ProjectConfig
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
			project
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
	project: ProjectConfig
): string | null {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedTarget = normalizePath(targetPath);

	// Try each path alias to see if it covers the target
	// Prioritize wildcard aliases over exact matches for paths with subpaths
	const candidates: Array<{
		alias: string;
		result: string;
		isWildcard: boolean;
	}> = [];

	for (const [alias, paths] of project.pathAliases) {
		const isWildcard = alias.endsWith("/*");

		for (const pathPattern of paths) {
			const resolvedPattern = pathPattern.endsWith("/*")
				? pathPattern.slice(0, -1)
				: pathPattern;

			const absolutePattern = normalizePath(
				path.resolve(baseUrl, resolvedPattern)
			);

			if (normalizedTarget.startsWith(absolutePattern)) {
				const remainder = normalizedTarget
					.slice(absolutePattern.length)
					.replace(/^\//, "") // strip leading slash left by path.normalize dropping trailing /
					.replace(/\.[tj]sx?$/, "");

				// For wildcard aliases, use them if there's a remainder
				// For exact aliases, only use if there's NO remainder (exact match)
				if (isWildcard && remainder) {
					const aliasPrefix = alias.slice(0, -1); // Remove /*
					candidates.push({
						alias,
						result: aliasPrefix + remainder,
						isWildcard: true,
					});
				} else if (!(isWildcard || remainder)) {
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
	project: ProjectConfig
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
	project: ProjectConfig
): string {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedNewTarget = normalizePath(newTargetPath);

	// Find which path pattern matched the old target
	for (const pathPattern of aliasMatch.paths) {
		const resolvedPattern = pathPattern.endsWith("/*")
			? pathPattern.slice(0, -1)
			: pathPattern;

		const absolutePattern = normalizePath(
			path.resolve(baseUrl, resolvedPattern)
		);

		if (oldTargetPath.startsWith(absolutePattern)) {
			// Check if the NEW target is ALSO within this alias scope
			if (normalizedNewTarget.startsWith(absolutePattern)) {
				// New target is in the same alias scope - update the remainder
				const newRemainder = normalizedNewTarget
					.slice(absolutePattern.length)
					.replace(/\.[tj]sx?$/, "");

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
	toFile: string
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
	return !(isRelativeImport(specifier) || path.isAbsolute(specifier));
}

/**
 * Normalize a file path (resolve symlinks, normalize slashes)
 */
export function normalizePath(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, "/");
}

/**
 * Find which package a file belongs to in a workspace
 */
export function findPackageForPath(
	filePath: string,
	workspace: WorkspaceInfo
): { packageName: string; packagePath: string } | null {
	const normalizedPath = normalizePath(filePath);

	for (const pkg of workspace.packages) {
		const normalizedPkgPath = normalizePath(pkg.path);
		if (normalizedPath.startsWith(`${normalizedPkgPath}/`)) {
			return { packageName: pkg.name, packagePath: pkg.path };
		}
	}

	return null;
}

/**
 * Check if two paths are in different workspace packages
 */
export function isCrossPackageMove(
	sourcePath: string,
	targetPath: string,
	workspace: WorkspaceInfo
): boolean {
	const sourcePackage = findPackageForPath(sourcePath, workspace);
	const targetPackage = findPackageForPath(targetPath, workspace);

	if (!(sourcePackage && targetPackage)) {
		return false;
	}

	return sourcePackage.packageName !== targetPackage.packageName;
}

/**
 * For cross-package moves, determine the best import specifier from the destination package.
 *
 * When addingToBarrel is true, assumes the file will be exported from the package's
 * main barrel (index.ts), so imports should use just the package name.
 */
export function findCrossPackageImport(
	targetPath: string,
	workspace: WorkspaceInfo,
	addingToBarrel = true
): string | null {
	const normalizedTarget = normalizePath(targetPath);
	const targetPackage = findPackageForPath(targetPath, workspace);

	if (!targetPackage) {
		return null;
	}

	const pkg = workspace.packages.find(
		(p) => p.name === targetPackage.packageName
	);
	if (!pkg) {
		return null;
	}

	// If we're adding to the barrel, just use the package name
	// The export will be added to the barrel, so consumers can import from the package
	if (addingToBarrel && pkg.srcDir) {
		const relativePath = path.relative(pkg.path, normalizedTarget);
		const subpath = relativePath.replace(/\.[tj]sx?$/, "");

		// If it's in the src directory, it will be exported from the barrel
		if (subpath.startsWith(`${pkg.srcDir}/`)) {
			// Just use the package name - the barrel will export it
			return pkg.name;
		}
	}

	// Get relative path within the package
	const relativePath = path.relative(pkg.path, normalizedTarget);
	const subpath = relativePath.replace(/\.[tj]sx?$/, "");

	// Check if this file matches a package.json export
	if (pkg.exports && typeof pkg.exports === "object") {
		for (const [exportKey, exportValue] of Object.entries(pkg.exports)) {
			// Normalize export key
			const normalizedKey = exportKey.replace(/^\.\//, "").replace(/^\.$/, "");

			// Check if subpath matches an export (accounting for src/ -> dist/ mapping)
			const srcSubpath = subpath.replace(/^src\//, "");
			if (
				normalizedKey === srcSubpath ||
				normalizedKey === `${srcSubpath}/index`
			) {
				return exportKey === "." ? pkg.name : `${pkg.name}/${normalizedKey}`;
			}

			// Handle wildcard exports
			if (exportKey.includes("*")) {
				// Check if the export value maps src to dist
				const valueStr = typeof exportValue === "string" ? exportValue : null;
				if (valueStr) {
					// e.g., "./*": "./dist/*.js" and we have "src/foo" -> try "foo"
					const srcSubpathNoExt = srcSubpath.replace(/\/index$/, "");
					const pattern = exportKey.replace("*", "(.+)").replace(/^\.\//, "");
					if (srcSubpathNoExt.match(new RegExp(`^${pattern}$`))) {
						return `${pkg.name}/${srcSubpathNoExt}`;
					}
				}
			}
		}
	}

	// Check if the package has a src directory that maps to main export
	if (pkg.srcDir && subpath.startsWith(`${pkg.srcDir}/`)) {
		const srcRelative = subpath.slice(pkg.srcDir.length + 1);
		// If it's the index file, use package name directly
		if (srcRelative === "index" || srcRelative === "") {
			return pkg.name;
		}
		// For non-index files, use package name (assumes barrel export)
		return pkg.name;
	}

	// Default: just use package name + subpath
	return subpath ? `${pkg.name}/${subpath}` : pkg.name;
}
