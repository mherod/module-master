import path from "node:path";
import { Glob } from "bun";

export interface WorkspacePackage {
	/** Package name from package.json */
	name: string;
	/** Absolute path to the package directory */
	path: string;
	/** Absolute path to package.json */
	packageJsonPath: string;
	/** Package version */
	version?: string;
	/** Main entrypoint (from "main" field) */
	main?: string;
	/** Module entrypoint (from "module" field) */
	module?: string;
	/** Types entrypoint (from "types" field) */
	types?: string;
	/** Export map (from "exports" field) */
	exports?: PackageExports;
	/** Source directory if detectable */
	srcDir?: string;
	/** Dependencies */
	dependencies?: Record<string, string>;
	/** Peer dependencies */
	peerDependencies?: Record<string, string>;
}

export type PackageExports =
	| string
	| { [key: string]: string | PackageExportConditions };

export interface PackageExportConditions {
	import?: string;
	require?: string;
	types?: string;
	default?: string;
	[key: string]: string | PackageExportConditions | undefined;
}

export interface WorkspaceInfo {
	/** Root directory of the workspace */
	root: string;
	/** Type of workspace (pnpm, yarn, npm) */
	type: "pnpm" | "yarn" | "npm" | "unknown";
	/** Workspace patterns from config */
	patterns: string[];
	/** All discovered packages */
	packages: WorkspacePackage[];
	/** Root package.json info */
	rootPackage?: {
		name?: string;
		version?: string;
	};
}

/**
 * Discover workspace configuration and all packages
 */
export async function discoverWorkspace(
	startDir: string,
): Promise<WorkspaceInfo | null> {
	const absoluteDir = path.resolve(startDir);

	// Find workspace root by looking for workspace config files
	const workspaceRoot = await findWorkspaceRoot(absoluteDir);
	if (!workspaceRoot) {
		return null;
	}

	const { root, type, patterns } = workspaceRoot;

	// Find all packages matching workspace patterns
	const packages = await findWorkspacePackages(root, patterns);

	// Read root package.json
	const rootPackageJson = await readPackageJson(path.join(root, "package.json"));

	return {
		root,
		type,
		patterns,
		packages,
		rootPackage: rootPackageJson
			? {
					name: rootPackageJson.name as string | undefined,
					version: rootPackageJson.version as string | undefined,
				}
			: undefined,
	};
}

/**
 * Find the workspace root directory and config
 */
async function findWorkspaceRoot(
	startDir: string,
): Promise<{ root: string; type: WorkspaceInfo["type"]; patterns: string[] } | null> {
	let currentDir = startDir;

	while (currentDir !== path.dirname(currentDir)) {
		// Check for pnpm-workspace.yaml
		const pnpmWorkspace = path.join(currentDir, "pnpm-workspace.yaml");
		if (await fileExists(pnpmWorkspace)) {
			const patterns = await parsePnpmWorkspace(pnpmWorkspace);
			return { root: currentDir, type: "pnpm", patterns };
		}

		// Check for package.json with workspaces field (yarn/npm)
		const packageJson = path.join(currentDir, "package.json");
		if (await fileExists(packageJson)) {
			const pkg = await readPackageJson(packageJson);
			if (pkg?.workspaces) {
				const workspaces = pkg.workspaces as string[] | { packages?: string[] };
				const patterns = Array.isArray(workspaces)
					? workspaces
					: workspaces.packages ?? [];
				const type = (await fileExists(path.join(currentDir, "yarn.lock")))
					? "yarn"
					: "npm";
				return { root: currentDir, type, patterns };
			}
		}

		currentDir = path.dirname(currentDir);
	}

	return null;
}

/**
 * Parse pnpm-workspace.yaml to extract workspace patterns
 */
async function parsePnpmWorkspace(filePath: string): Promise<string[]> {
	try {
		const content = await Bun.file(filePath).text();
		// Simple YAML parsing for packages array
		const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
		if (packagesMatch?.[1]) {
			const lines = packagesMatch[1].split("\n");
			return lines
				.map((line) => {
					const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
					return match?.[1] ?? null;
				})
				.filter((p): p is string => p !== null);
		}
	} catch {
		// Ignore parse errors
	}
	return [];
}

/**
 * Find all packages in the workspace
 */
async function findWorkspacePackages(
	root: string,
	patterns: string[],
): Promise<WorkspacePackage[]> {
	const packages: WorkspacePackage[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		// Convert workspace pattern to glob for package.json files
		const globPattern = pattern.includes("*")
			? path.join(pattern, "package.json")
			: path.join(pattern, "package.json");

		try {
			const glob = new Glob(globPattern);
			for await (const match of glob.scan({ cwd: root, absolute: true })) {
				// Skip node_modules
				if (match.includes("node_modules")) continue;

				const packageJsonPath = match;
				if (seen.has(packageJsonPath)) continue;
				seen.add(packageJsonPath);

				const pkg = await parsePackage(packageJsonPath);
				if (pkg) {
					packages.push(pkg);
				}
			}
		} catch {
			// Ignore glob errors
		}
	}

	// Sort by name
	packages.sort((a, b) => a.name.localeCompare(b.name));

	return packages;
}

/**
 * Parse a package.json file into WorkspacePackage
 */
async function parsePackage(
	packageJsonPath: string,
): Promise<WorkspacePackage | null> {
	const pkg = await readPackageJson(packageJsonPath);
	if (!pkg?.name) return null;

	const pkgDir = path.dirname(packageJsonPath);

	// Try to detect source directory
	let srcDir: string | undefined;
	for (const candidate of ["src", "lib", "source"]) {
		const candidatePath = path.join(pkgDir, candidate);
		if (await fileExists(candidatePath)) {
			srcDir = candidate;
			break;
		}
	}

	return {
		name: pkg.name as string,
		path: pkgDir,
		packageJsonPath,
		version: pkg.version as string | undefined,
		main: pkg.main as string | undefined,
		module: pkg.module as string | undefined,
		types: (pkg.types ?? pkg.typings) as string | undefined,
		exports: pkg.exports as PackageExports | undefined,
		srcDir,
		dependencies: pkg.dependencies as Record<string, string> | undefined,
		peerDependencies: pkg.peerDependencies as Record<string, string> | undefined,
	};
}

/**
 * Read and parse a package.json file
 */
async function readPackageJson(
	filePath: string,
): Promise<Record<string, unknown> | null> {
	try {
		const content = await Bun.file(filePath).text();
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		return await Bun.file(filePath).exists();
	} catch {
		return false;
	}
}

/**
 * Resolve the import path for a file within a workspace package
 */
export function resolvePackageImport(
	targetPath: string,
	workspace: WorkspaceInfo,
): { packageName: string; subpath: string; resolvedImport: string } | null {
	const normalizedTarget = path.normalize(targetPath);

	for (const pkg of workspace.packages) {
		if (normalizedTarget.startsWith(pkg.path + path.sep)) {
			const relativePath = path.relative(pkg.path, normalizedTarget);
			const subpath = relativePath.replace(/\.[tj]sx?$/, ""); // Remove extension

			// Check if this matches an export in the package
			const exportPath = findMatchingExport(pkg, subpath);
			if (exportPath) {
				return {
					packageName: pkg.name,
					subpath,
					resolvedImport: exportPath,
				};
			}

			// Fall back to package name + subpath
			// Check if it's in src/ and the package exports from dist/
			if (subpath.startsWith("src/") && pkg.main?.includes("dist")) {
				// Can't import from src/ when package exports dist/
				return null;
			}

			return {
				packageName: pkg.name,
				subpath,
				resolvedImport: subpath ? `${pkg.name}/${subpath}` : pkg.name,
			};
		}
	}

	return null;
}

/**
 * Find a matching export path in package.json exports
 */
function findMatchingExport(
	pkg: WorkspacePackage,
	subpath: string,
): string | null {
	if (!pkg.exports) return null;

	// Handle string exports (simple case)
	if (typeof pkg.exports === "string") {
		if (subpath === "" || subpath === "index") {
			return pkg.name;
		}
		return null;
	}

	// Handle exports map
	for (const [exportKey, exportValue] of Object.entries(pkg.exports)) {
		// Normalize export key (remove leading ./)
		const normalizedKey = exportKey.replace(/^\.\//, "").replace(/^\.$/, "");

		if (normalizedKey === subpath || normalizedKey === subpath + "/index") {
			const resolvedPath =
				exportKey === "." ? pkg.name : `${pkg.name}/${normalizedKey}`;
			return resolvedPath;
		}

		// Handle wildcard exports like "./*": "./dist/*"
		if (exportKey.includes("*")) {
			const pattern = exportKey.replace("*", "(.+)");
			const regex = new RegExp(`^${pattern}$`);
			const match = `./${subpath}`.match(regex);
			if (match) {
				return `${pkg.name}/${match[1]}`;
			}
		}
	}

	return null;
}

/**
 * Print workspace info to console
 */
export function printWorkspaceInfo(workspace: WorkspaceInfo): void {
	console.log(`\n📦 Workspace: ${workspace.rootPackage?.name ?? "(unnamed)"}`);
	console.log(`   Root: ${workspace.root}`);
	console.log(`   Type: ${workspace.type}`);
	console.log(`   Patterns: ${workspace.patterns.join(", ")}`);
	console.log(`\n📚 Packages (${workspace.packages.length}):\n`);

	for (const pkg of workspace.packages) {
		const relativePath = path.relative(workspace.root, pkg.path);
		console.log(`   📁 ${pkg.name}`);
		console.log(`      Path: ${relativePath}`);

		if (pkg.main) {
			console.log(`      Main: ${pkg.main}`);
		}
		if (pkg.module) {
			console.log(`      Module: ${pkg.module}`);
		}
		if (pkg.types) {
			console.log(`      Types: ${pkg.types}`);
		}
		if (pkg.srcDir) {
			console.log(`      Source: ${pkg.srcDir}/`);
		}

		if (pkg.exports && typeof pkg.exports === "object") {
			const exportKeys = Object.keys(pkg.exports);
			if (exportKeys.length > 0) {
				console.log(`      Exports: ${exportKeys.slice(0, 5).join(", ")}${exportKeys.length > 5 ? ` (+${exportKeys.length - 5} more)` : ""}`);
			}
		}

		console.log();
	}
}
