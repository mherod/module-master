import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { scanExports } from "../core/scanner.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { ExportInfo } from "../types.ts";

export interface FindOptions {
	query: string;
	project: string;
	type?: "file" | "export" | "all";
	verbose?: boolean;
	workspace?: boolean;
}

export interface FindResult {
	files: FileMatch[];
	exports: ExportMatch[];
}

export interface FileMatch {
	path: string;
	relativePath: string;
	filename: string;
}

export interface ExportMatch {
	file: string;
	relativePath: string;
	export: ExportInfo;
}

export async function findCommand(options: FindOptions): Promise<void> {
	const { query, project, type = "all", verbose, workspace = false } = options;
	const absoluteProject = path.resolve(project);

	if (workspace) {
		const wsInfo = await discoverWorkspace(absoluteProject);
		if (!wsInfo || wsInfo.packages.length === 0) {
			logger.error("No workspace packages found.");
			process.exit(1);
		}

		logger.info(
			`\n🔍 Searching for "${query}" across ${wsInfo.packages.length} workspace package(s)\n`
		);

		const allFiles = new Map<string, unknown>();
		for (const pkg of wsInfo.packages) {
			const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
			const discovery = discoverProject(scanDir);
			for (const [filePath, owner] of discovery.fileOwnership) {
				allFiles.set(filePath, owner);
			}
		}

		const result = search(query, allFiles, absoluteProject, type);
		printResults(result, absoluteProject, verbose);
		return;
	}

	logger.info(`\n🔍 Searching for "${query}" in ${absoluteProject}\n`);

	const discovery = discoverProject(absoluteProject);

	if (discovery.configs.length === 0) {
		logger.error("No tsconfig.json files found in project.");
		process.exit(1);
	}

	const result = search(query, discovery.fileOwnership, absoluteProject, type);

	printResults(result, absoluteProject, verbose);
}

function search(
	query: string,
	fileOwnership: Map<string, unknown>,
	baseDir: string,
	type: "file" | "export" | "all"
): FindResult {
	const files: FileMatch[] = [];
	const exports: ExportMatch[] = [];
	const queryLower = query.toLowerCase();
	const allFiles = Array.from(fileOwnership.keys());

	// Search files by name
	if (type === "file" || type === "all") {
		for (const filePath of allFiles) {
			const filename = path.basename(filePath);
			const filenameWithoutExt = filename.replace(/\.[^.]+$/, "");

			if (
				filename.toLowerCase().includes(queryLower) ||
				filenameWithoutExt.toLowerCase() === queryLower
			) {
				files.push({
					path: filePath,
					relativePath: path.relative(baseDir, filePath),
					filename,
				});
			}
		}
	}

	// Search exports by name
	if (type === "export" || type === "all") {
		for (const filePath of allFiles) {
			// Only scan TypeScript/JavaScript files
			if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath)) {
				continue;
			}

			try {
				const fileExports = getFileExports(filePath);

				for (const exp of fileExports) {
					if (exp.name.toLowerCase().includes(queryLower)) {
						exports.push({
							file: filePath,
							relativePath: path.relative(baseDir, filePath),
							export: exp,
						});
					}
				}
			} catch {
				// Skip files that can't be parsed
			}
		}
	}

	// Sort results: exact matches first, then alphabetically
	files.sort((a, b) => {
		const aExact =
			a.filename.toLowerCase().replace(/\.[^.]+$/, "") === queryLower;
		const bExact =
			b.filename.toLowerCase().replace(/\.[^.]+$/, "") === queryLower;
		if (aExact && !bExact) {
			return -1;
		}
		if (!aExact && bExact) {
			return 1;
		}
		return a.relativePath.localeCompare(b.relativePath);
	});

	exports.sort((a, b) => {
		const aExact = a.export.name.toLowerCase() === queryLower;
		const bExact = b.export.name.toLowerCase() === queryLower;
		if (aExact && !bExact) {
			return -1;
		}
		if (!aExact && bExact) {
			return 1;
		}
		return a.export.name.localeCompare(b.export.name);
	});

	return { files, exports };
}

function getFileExports(filePath: string): ExportInfo[] {
	const content = ts.sys.readFile(filePath);
	if (!content) {
		return [];
	}

	const sourceFile = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true
	);

	return scanExports(sourceFile);
}

function printResults(
	result: FindResult,
	baseDir: string,
	verbose?: boolean
): void {
	const { files, exports } = result;
	const totalResults = files.length + exports.length;

	if (totalResults === 0) {
		logger.info("No matches found.\n");
		return;
	}

	// Files
	if (files.length > 0) {
		logger.info(`📁 Files (${files.length}):`);
		for (const file of files) {
			logger.info(`   ${file.relativePath}`);
		}
		logger.empty();
	}

	// Exports
	if (exports.length > 0) {
		logger.info(`📤 Exports (${exports.length}):`);

		// Group by file for cleaner output
		const byFile = new Map<string, ExportMatch[]>();
		for (const exp of exports) {
			const existing = byFile.get(exp.relativePath) ?? [];
			existing.push(exp);
			byFile.set(exp.relativePath, existing);
		}

		for (const [relativePath, fileExports] of byFile) {
			logger.info(`   ${relativePath}`);
			for (const exp of fileExports) {
				const typeMarker = exp.export.isType ? " (type)" : "";
				const defaultMarker = exp.export.type === "default" ? " [default]" : "";
				logger.info(
					`      • ${exp.export.name}${typeMarker}${defaultMarker} (line ${exp.export.line})`
				);
			}
		}
		logger.empty();
	}

	logger.info(`Found ${totalResults} result(s).\n`);

	const firstFile = files[0];
	if (verbose && firstFile) {
		logger.info("💡 To analyze a file, run:");
		logger.info(`   bun src/cli.ts analyze ${firstFile.path} -p ${baseDir}\n`);
	}
}
