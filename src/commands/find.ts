import path from "node:path";
import ts from "typescript";
import { scanExports } from "../core/scanner.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
import type { ExportInfo } from "../types.ts";

export interface FindOptions {
	query: string;
	project: string;
	type?: "file" | "export" | "all";
	verbose?: boolean;
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
	const { query, project, type = "all", verbose } = options;
	const absoluteProject = path.resolve(project);

	console.log(`\n🔍 Searching for "${query}" in ${absoluteProject}\n`);

	const discovery = discoverProject(absoluteProject);

	if (discovery.configs.length === 0) {
		console.error("No tsconfig.json files found in project.");
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
		console.log("No matches found.\n");
		return;
	}

	// Files
	if (files.length > 0) {
		console.log(`📁 Files (${files.length}):`);
		for (const file of files) {
			console.log(`   ${file.relativePath}`);
		}
		console.log();
	}

	// Exports
	if (exports.length > 0) {
		console.log(`📤 Exports (${exports.length}):`);

		// Group by file for cleaner output
		const byFile = new Map<string, ExportMatch[]>();
		for (const exp of exports) {
			const existing = byFile.get(exp.relativePath) ?? [];
			existing.push(exp);
			byFile.set(exp.relativePath, existing);
		}

		for (const [relativePath, fileExports] of byFile) {
			console.log(`   ${relativePath}`);
			for (const exp of fileExports) {
				const typeMarker = exp.export.isType ? " (type)" : "";
				const defaultMarker = exp.export.type === "default" ? " [default]" : "";
				console.log(
					`      • ${exp.export.name}${typeMarker}${defaultMarker} (line ${exp.export.line})`
				);
			}
		}
		console.log();
	}

	console.log(`Found ${totalResults} result(s).\n`);

	const firstFile = files[0];
	if (verbose && firstFile) {
		console.log("💡 To analyze a file, run:");
		console.log(`   bun src/cli.ts analyze ${firstFile.path} -p ${baseDir}\n`);
	}
}
