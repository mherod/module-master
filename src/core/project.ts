import ts from "typescript";
import type { ProjectConfig } from "../types.ts";

/**
 * Find and parse the tsconfig.json for a project
 */
export function findTsConfig(startDir: string): string | null {
	const configPath = ts.findConfigFile(
		startDir,
		ts.sys.fileExists,
		"tsconfig.json",
	);
	return configPath ?? null;
}

/**
 * Load project configuration from tsconfig.json
 */
export function loadProject(tsconfigPath: string): ProjectConfig {
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

	if (configFile.error) {
		throw new Error(
			`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
		);
	}

	const rootDir = tsconfigPath.replace(/[/\\]tsconfig\.json$/, "");

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		rootDir,
	);

	if (parsed.errors.length > 0) {
		const messages = parsed.errors
			.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
			.join("\n");
		throw new Error(`Failed to parse tsconfig: ${messages}`);
	}

	const pathAliases = extractPathAliases(parsed.options);

	return {
		rootDir,
		tsconfigPath,
		compilerOptions: parsed.options,
		pathAliases,
	};
}

/**
 * Extract path aliases from compiler options
 */
function extractPathAliases(
	options: ts.CompilerOptions,
): Map<string, string[]> {
	const aliases = new Map<string, string[]>();

	if (options.paths) {
		for (const [alias, paths] of Object.entries(options.paths)) {
			aliases.set(alias, paths);
		}
	}

	return aliases;
}

/**
 * Create a TypeScript program for analysis
 */
export function createProgram(
	project: ProjectConfig,
	files?: string[],
): ts.Program {
	const host = ts.createCompilerHost(project.compilerOptions);

	if (files) {
		return ts.createProgram(files, project.compilerOptions, host);
	}

	// Get all files from the project
	const configPath = project.tsconfigPath;
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		project.rootDir,
	);

	return ts.createProgram(parsed.fileNames, project.compilerOptions, host);
}

/**
 * Get all TypeScript/JavaScript files in the project
 */
export function getProjectFiles(project: ProjectConfig): string[] {
	const configFile = ts.readConfigFile(project.tsconfigPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		project.rootDir,
	);
	return parsed.fileNames;
}
