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
		deadCount: report.deadCount,
		internalOnlyCount: report.internalOnlyCount,
		scannedConfigs: report.scannedConfigs.map((c) =>
			path.relative(absoluteDir, c)
		),
		scannedFileCount: report.scannedFileCount,
		unused: report.unused.map((u) => ({
			name: u.name,
			file: path.relative(absoluteDir, u.file),
			line: u.line,
			isType: u.isType,
			kind: u.type,
			internalUsage: u.internalUsage,
			internalRefCount: u.internalRefCount,
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
			"Locate where a symbol or file lives when you know its name but not its path. Searches BOTH filenames and exported symbol names with case-insensitive partial matching (e.g. 'user' matches UserService.ts and `getUserById`). Use this FIRST to turn a name into a concrete file path + line before calling `analyze`, or before a CLI move/rename. Exact matches rank ahead of partial ones. Returns matched file paths plus exports (name, file, line, kind, isType). Read-only.",
		inputSchema: {
			query: z
				.string()
				.describe(
					"Symbol or filename fragment, case-insensitive and partial (e.g. 'Entity', 'parseConfig')"
				),
			project: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project root or a tsconfig.json; its tsconfig determines which files are in scope"
				),
			type: z
				.enum(["file", "export", "all"])
				.optional()
				.describe(
					"Restrict matches: 'file' = filenames only, 'export' = exported symbol names only, 'all' = both (default 'all')"
				),
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
			"Get the full dependency picture of ONE module before you edit, move, rename, or delete it. Reports the file's exports, its imports (with bindings and type-only flags), every file that references it (reverse dependencies — the blast radius of a change), barrel files that re-export it, imports that fail to resolve, and exports that no other file imports. Reach for this whenever you need to understand impact or wiring of a specific file; use `find` first if you only know the name. Pass a file, not a directory. Read-only.",
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the single source file to analyze (e.g. 'src/core/graph.ts')"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file (recommended)"
				),
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
			"Map the TypeScript project topology of an unfamiliar repo before doing anything else. Recursively finds every tsconfig.json and reports the root config, total owned file count, and per-config rootDir, solution-style flag, file count, extends chain, project-reference count, and path aliases. Use this to learn how a repo is laid out, where path aliases (e.g. '@/…') point, and which config owns which files — context that `analyze`/`audit` need. For monorepo PACKAGE metadata (entrypoints, published exports) use `workspace` instead. Read-only.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the directory to scan for tsconfig.json files (usually the repo root)"
				),
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
			"Enumerate the packages in a pnpm/yarn/npm monorepo and how each is wired. Reads pnpm-workspace.yaml or the package.json 'workspaces' field, then reports per package: name, main/module/types entrypoints, the 'exports' map, dependencies, detected barrel (index) files, and tsconfig path. Use this in a monorepo to see what packages exist and their public surface before a cross-package move or import. For tsconfig/path-alias topology (including single-package repos) use `discover` instead. Returns an error if the directory is not a workspace root. Read-only.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the workspace root (the directory containing pnpm-workspace.yaml or a package.json with a 'workspaces' field)"
				),
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
			"Assess architectural health across a whole project and surface refactoring targets. Builds the import graph and reports: circular dependencies (cycles), files with high fan-out (import too many modules — likely doing too much), files with high fan-in (imported by many — high-blast-radius hubs), and files with large export surfaces. Use this to find god modules, over-coupled files, and dependency cycles, or to answer 'what's the riskiest/most-tangled part of this codebase?'. To drill into one file the audit flags, follow up with `analyze`. Tune thresholds to widen or narrow what gets flagged. Read-only.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			fanOutThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files that import more than N distinct modules (default 10). Lower to surface more candidates"
				),
			fanInThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files imported by more than N distinct files (default 10). High fan-in marks hub modules"
				),
			exportThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files exporting more than N symbols (default 8). High counts suggest a module doing too much"
				),
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
			"Find exports that no OTHER file in the project imports. A hit is a DE-EXPORT signal, not automatically a DELETE signal: each entry carries `internalUsage`/`internalRefCount` telling you whether the symbol is still referenced WITHIN its own file. `internalUsage:false` (`internalRefCount:0`) means referenced nowhere — safe to delete; `internalUsage:true` means only the `export` keyword is redundant — deleting the symbol would break its own module, so just drop the `export`. The report also returns `deadCount` (deletable) and `internalOnlyCount` (de-export only). Aliased imports (`import { a as b }`) count as cross-file usage; whole-module imports (`import *`, `export *`, dynamic `import()`, `require()`) mark every export of that module as used. Usage is counted across ALL tsconfigs discovered in the project (the scanned set is returned as `scannedConfigs`/`scannedFileCount`), so an export consumed only by a sibling config (e.g. `scripts/` on `tsconfig.scripts.json`) is not falsely reported dead. The `ignore` glob suppresses files only as reported candidates — ignored files (e.g. tests) still count as usage sources, so a test-only export is not reported dead. Expect false positives only for genuine entry points / public API consumed entirely outside this project. Returns total export/file counts, `deadCount`, `internalOnlyCount`, `scannedConfigs`, `scannedFileCount`, and the unused list (name, file, line, kind, isType, internalUsage, internalRefCount). Read-only.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			ignore: z
				.string()
				.optional()
				.describe(
					"Glob of files to exclude from the scan, e.g. '*.test.ts' to drop test files (which often hold the only references)"
				),
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
			"Find duplicate or near-duplicate top-level declarations (functions, type aliases, interfaces) that are candidates for consolidation. Use this to hunt copy-paste code, redundant types, or DRY opportunities across the project. Groups declarations by structural similarity and returns each group with its similarity bucket, score, and members (name, kind, file, line). Tune `threshold` for how alike members must be, and use `sameNameOnly`/`nameThreshold`/`minLines`/`kinds`/`skipSameFile` to narrow noise. Identifies candidates only — it does not merge anything. Read-only.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			threshold: z
				.number()
				.optional()
				.describe(
					"Minimum structural similarity to group, 0.0–1.0 (default 0.8). Higher = only very-alike declarations; lower = more, looser matches"
				),
			maxGroups: z
				.number()
				.optional()
				.describe(
					"Cap on groups returned, highest-scoring first; 0 = unlimited (default 10)"
				),
			nameThreshold: z
				.number()
				.optional()
				.describe(
					"Also require member NAME similarity to meet this score (0.0–1.0), so only similarly-named declarations group together"
				),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe(
					"Only group declarations that share an identical name (strictest name filter; overrides nameThreshold)"
				),
			skipSameFile: z
				.boolean()
				.optional()
				.describe(
					"Drop groups whose members all live in one file, leaving only cross-file duplication"
				),
			minLines: z
				.number()
				.optional()
				.describe(
					"Ignore declarations whose body has fewer than N lines, to skip trivial one-liners"
				),
			kinds: z
				.array(z.enum(["function", "type", "interface"]))
				.optional()
				.describe(
					"Limit to specific declaration kinds (default: all of function, type, interface)"
				),
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
