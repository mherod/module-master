#!/usr/bin/env bun

/**
 * resect MCP server — exposes resect's read-only analysis capabilities as
 * Model Context Protocol tools over stdio.
 *
 * Design notes:
 *  - A stdio MCP server speaks JSON-RPC on stdout, so NOTHING may be written to
 *    stdout except the transport itself. This entry deliberately calls the
 *    data-returning functions (`search`, `analyze`, `buildAuditReport`, …)
 *    rather than the `*Command` wrappers, which print via the `logger`
 *    (stdout) and call `process.exit()` on bad input — both fatal here.
 *  - Every tool handler is wrapped in try/catch so failures become an `isError`
 *    result instead of throwing/exiting and killing the server.
 *  - Only read-only tools are exposed. Mutating commands (move/rename/alias/
 *    extract-common) would need dry-run-by-default + structured results before
 *    they can be exposed safely.
 */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { version } from "../package.json";
import { analyze } from "./commands/analyze.ts";
import { buildAuditReport } from "./commands/audit.ts";
import { search } from "./commands/find.ts";
import { findUnusedExports } from "./commands/unused.ts";
import { buildDependencyGraph } from "./core/graph.ts";
import { loadProject, resolveTsConfig } from "./core/project.ts";
import { analyzeSimilarity } from "./core/similarity.ts";
import { discoverProject } from "./core/tsconfig-discovery.ts";
import { discoverWorkspace } from "./core/workspace.ts";

// ── Result helpers ──────────────────────────────────────────────────

/** Convert Map/Set values so JSON.stringify produces readable output. */
function mapReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	if (value instanceof Set) {
		return [...value];
	}
	return value;
}

function jsonText(data: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, mapReplacer, 2) }],
	};
}

function errorText(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Format any thrown error as an `isError` tool result. */
function toError(error: unknown): CallToolResult {
	return errorText(error instanceof Error ? error.message : String(error));
}

// ── Tool implementations ────────────────────────────────────────────

function findTool(
	query: string,
	project: string,
	type: "file" | "export" | "all" = "all"
): CallToolResult {
	const absoluteProject = path.resolve(project);
	const discovery = discoverProject(absoluteProject);
	if (discovery.configs.length === 0) {
		return errorText(`No tsconfig.json files found in ${absoluteProject}`);
	}
	const result = search(query, discovery.fileOwnership, absoluteProject, type);
	return jsonText({
		query,
		files: result.files.map((f) => f.relativePath),
		exports: result.exports.map((e) => ({
			name: e.export.name,
			file: e.relativePath,
			line: e.export.line,
			isType: e.export.isType,
			kind: e.export.type,
		})),
	});
}

async function analyzeTool(
	file: string,
	project?: string
): Promise<CallToolResult> {
	const absolutePath = path.resolve(file);
	const tsconfigPath = resolveTsConfig(project, path.dirname(absolutePath));
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absolutePath}`);
	}
	const projectConfig = loadProject(tsconfigPath, absolutePath);
	const result = await analyze(absolutePath, projectConfig);
	const root = projectConfig.rootDir;
	return jsonText({
		file: path.relative(root, result.file),
		exports: result.exports.map((e) => ({
			name: e.name,
			line: e.line,
			isType: e.isType,
			kind: e.type,
		})),
		imports: result.imports.map((i) => ({
			specifier: i.specifier,
			type: i.type,
			line: i.line,
			isTypeOnly: i.isTypeOnly,
			bindings: i.bindings?.map((b) =>
				b.alias ? `${b.name} as ${b.alias}` : b.name
			),
		})),
		referencedBy: result.referencedBy.map((r) => ({
			file: path.relative(root, r.sourceFile),
			line: r.line,
			type: r.type,
			specifier: r.specifier,
		})),
		barrelReExports: result.barrelExports.map((b) =>
			path.relative(root, b.barrelPath)
		),
		unresolvableImports: result.unresolvable.map((u) => ({
			specifier: u.specifier,
			line: u.line,
		})),
		unusedExports: result.unusedExports.map((e) => ({
			name: e.name,
			line: e.line,
			isType: e.isType,
		})),
	});
}

function discoverTool(directory: string): CallToolResult {
	const absoluteDir = path.resolve(directory);
	const discovery = discoverProject(absoluteDir);
	return jsonText({
		rootConfig: discovery.rootConfig
			? path.relative(absoluteDir, discovery.rootConfig.path)
			: null,
		totalFiles: discovery.fileOwnership.size,
		configs: discovery.configs.map((c) => ({
			path: path.relative(absoluteDir, c.path),
			rootDir: path.relative(absoluteDir, c.rootDir) || ".",
			isSolution: c.isSolution,
			fileCount: c.files.length,
			extends: c.extends ? path.relative(absoluteDir, c.extends) : null,
			references: c.references.length,
			pathAliases: Object.fromEntries(c.pathAliases),
		})),
	});
}

async function workspaceTool(directory: string): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const ws = await discoverWorkspace(absoluteDir);
	if (!ws) {
		return errorText(`No workspace found in ${absoluteDir}`);
	}
	return jsonText(ws);
}

async function auditTool(
	directory: string,
	options: {
		project?: string;
		fanOutThreshold?: number;
		fanInThreshold?: number;
		exportThreshold?: number;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const projectConfig = loadProject(tsconfigPath);
	const graph = await buildDependencyGraph(projectConfig);
	const thresholds = {
		fanOutThreshold: options.fanOutThreshold ?? 10,
		fanInThreshold: options.fanInThreshold ?? 10,
		exportThreshold: options.exportThreshold ?? 8,
	};
	const report = buildAuditReport(graph, thresholds);
	return jsonText({
		totalFiles: report.totalFiles,
		thresholds,
		cycles: report.cycles.map((c) => ({
			files: c.files.map((f) => path.relative(absoluteDir, f)),
		})),
		highFanOut: report.highFanOut.map((m) => ({
			...m,
			file: path.relative(absoluteDir, m.file),
		})),
		highFanIn: report.highFanIn.map((m) => ({
			...m,
			file: path.relative(absoluteDir, m.file),
		})),
		largeExportSurface: report.largeExportSurface.map((m) => ({
			...m,
			file: path.relative(absoluteDir, m.file),
		})),
	});
}

async function unusedTool(
	directory: string,
	options: { project?: string; ignore?: string }
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const report = await findUnusedExports(directory, {
		project: options.project,
		ignore: options.ignore,
	});
	return jsonText({
		totalExports: report.totalExports,
		totalFiles: report.totalFiles,
		unusedCount: report.unused.length,
		unused: report.unused.map((u) => ({
			name: u.name,
			file: path.relative(absoluteDir, u.file),
			line: u.line,
			isType: u.isType,
			kind: u.type,
		})),
	});
}

async function similarTool(
	directory: string,
	options: {
		project?: string;
		threshold?: number;
		maxGroups?: number;
		nameThreshold?: number;
		sameNameOnly?: boolean;
		skipSameFile?: boolean;
		minLines?: number;
		kinds?: ("function" | "type" | "interface")[];
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold: options.threshold ?? 0.8,
		project: options.project,
		nameThreshold: options.nameThreshold,
		sameNameOnly: options.sameNameOnly,
		skipSameFile: options.skipSameFile,
		minLines: options.minLines,
		kinds: options.kinds,
	});
	const maxGroups = options.maxGroups ?? 10;
	const groups =
		maxGroups > 0 ? report.groups.slice(0, maxGroups) : report.groups;
	return jsonText({
		totalDeclarations: report.totalFunctions,
		totalFiles: report.totalFiles,
		totalGroups: report.groups.length,
		shown: groups.length,
		groups: groups.map((g) => ({
			bucket: g.bucket,
			score: g.score,
			members: g.functions.map((fn) => ({
				name: fn.name,
				kind: fn.kind,
				file: path.relative(absoluteDir, fn.file),
				line: fn.line,
			})),
		})),
	});
}

// ── Server wiring ───────────────────────────────────────────────────

const server = new McpServer({ name: "resect", version });

server.registerTool(
	"find",
	{
		description:
			"Find files and exports by name across a TypeScript/JavaScript project (case-insensitive, partial match).",
		inputSchema: {
			query: z.string().describe("Name to search for"),
			project: z
				.string()
				.describe("Path to the project directory or tsconfig.json"),
			type: z
				.enum(["file", "export", "all"])
				.optional()
				.describe("Filter results (default: all)"),
		},
	},
	async ({ query, project, type }) => {
		try {
			return findTool(query, project, type);
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"analyze",
	{
		description:
			"Analyze a module's exports, imports, the files that reference it, barrel re-exports, unresolvable imports, and unused exports.",
		inputSchema: {
			file: z.string().describe("Path to the file to analyze"),
			project: z
				.string()
				.optional()
				.describe("Path to the project directory or tsconfig.json"),
		},
	},
	async ({ file, project }) => {
		try {
			return await analyzeTool(file, project);
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"discover",
	{
		description:
			"Discover all tsconfig.json files in a directory and report project structure: configs, extends chains, references, path aliases, and file ownership counts.",
		inputSchema: {
			directory: z.string().describe("Path to the project directory to scan"),
		},
	},
	async ({ directory }) => {
		try {
			return discoverTool(directory);
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"workspace",
	{
		description:
			"Discover pnpm/yarn/npm workspace packages and their structure (entrypoints, exports, barrels, tsconfig paths).",
		inputSchema: {
			directory: z.string().describe("Path to the workspace root"),
		},
	},
	async ({ directory }) => {
		try {
			return await workspaceTool(directory);
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"audit",
	{
		description:
			"Analyze module health: fan-out, fan-in, instability, large export surfaces, and circular dependencies.",
		inputSchema: {
			directory: z.string().describe("Path to the project directory to scan"),
			project: z
				.string()
				.optional()
				.describe("Path to the project directory or tsconfig.json"),
			fanOutThreshold: z
				.number()
				.optional()
				.describe("Flag files importing more than N modules (default: 10)"),
			fanInThreshold: z
				.number()
				.optional()
				.describe("Flag files imported by more than N files (default: 10)"),
			exportThreshold: z
				.number()
				.optional()
				.describe("Flag files with more than N exports (default: 8)"),
		},
	},
	async ({
		directory,
		project,
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	}) => {
		try {
			return await auditTool(directory, {
				project,
				fanOutThreshold,
				fanInThreshold,
				exportThreshold,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"unused",
	{
		description:
			"Find exports that are never imported by any other file in the project.",
		inputSchema: {
			directory: z.string().describe("Path to the project directory to scan"),
			project: z
				.string()
				.optional()
				.describe("Path to the project directory or tsconfig.json"),
			ignore: z
				.string()
				.optional()
				.describe('Glob pattern to exclude files (e.g. "*.test.ts")'),
		},
	},
	async ({ directory, project, ignore }) => {
		try {
			return await unusedTool(directory, { project, ignore });
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"similar",
	{
		description:
			"Find similar or duplicate top-level functions, type aliases, and interfaces that are candidates for consolidation.",
		inputSchema: {
			directory: z.string().describe("Path to the project directory to scan"),
			project: z
				.string()
				.optional()
				.describe("Path to the project directory or tsconfig.json"),
			threshold: z
				.number()
				.optional()
				.describe("Minimum similarity score 0.0–1.0 (default: 0.8)"),
			maxGroups: z
				.number()
				.optional()
				.describe("Max groups to return; 0 for unlimited (default: 10)"),
			nameThreshold: z
				.number()
				.optional()
				.describe("Only group declarations whose names also meet this score"),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe("Only group declarations with identical names"),
			skipSameFile: z
				.boolean()
				.optional()
				.describe("Skip groups where all declarations are in the same file"),
			minLines: z
				.number()
				.optional()
				.describe("Exclude declarations with fewer body lines"),
			kinds: z
				.array(z.enum(["function", "type", "interface"]))
				.optional()
				.describe("Declaration kinds to include (default: all)"),
		},
	},
	async ({
		directory,
		project,
		threshold,
		maxGroups,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		minLines,
		kinds,
	}) => {
		try {
			return await similarTool(directory, {
				project,
				threshold,
				maxGroups,
				nameThreshold,
				sameNameOnly,
				skipSameFile,
				minLines,
				kinds,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(`resect MCP server v${version} running on stdio\n`);
}

main().catch((error) => {
	process.stderr.write(
		`Fatal error: ${error instanceof Error ? error.stack : String(error)}\n`
	);
	process.exit(1);
});
