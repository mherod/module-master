#!/usr/bin/env bun

/**
 * resect MCP server — exposes resect's analysis and refactoring capabilities as
 * Model Context Protocol tools over stdio.
 *
 * Design notes:
 *  - A stdio MCP server speaks JSON-RPC on stdout, so NOTHING may be written to
 *    stdout except the transport itself. This entry deliberately calls the
 *    data-returning functions (`search`, `analyze`, `buildAuditReport`,
 *    `moveModule`, `renameSymbol`, `normalizeImports`, …) rather than the
 *    `*Command` wrappers, which print via the `logger` (stdout) and call
 *    `process.exit()` on bad input — both fatal here.
 *  - Every tool handler is wrapped in try/catch so failures become an `isError`
 *    result instead of throwing/exiting and killing the server.
 *  - Mutating tools (`move`, `rename`, `alias`) default to `dryRun: true` so
 *    callers always preview the diff first. When `dryRun` is false and
 *    `verify` is on (the default), each tool runs `tsc --noEmit` before AND
 *    after applying changes; the diagnostic delta is included in the result
 *    so the caller can see exactly which errors the refactor introduced or
 *    fixed.
 *  - Mutating tools use `isWorktreeDirty` (not `ensureCleanWorktree`, which
 *    calls `process.exit`). A dirty worktree becomes a structured error
 *    unless `force: true` is set.
 *  - `extract-common` is intentionally not exposed yet — its output shape and
 *    interactive ordering need a structured-result rewrite first. Tracked in
 *    issue #60.
 */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { version } from "../package.json";
import {
	type AliasResult,
	applyChanges as applyAliasChanges,
	applyChangesWithVerification as applyAliasChangesWithVerification,
	normalizeImports,
	parseSpecifierRenames,
	renameImportSpecifiers,
} from "./commands/alias.ts";
import { analyze } from "./commands/analyze.ts";
import { buildAuditReport } from "./commands/audit.ts";
import { runExtractCommon } from "./commands/extract-common.ts";
import { search } from "./commands/find.ts";
import {
	applyMockCleanup,
	buildMockCleanupReport,
} from "./commands/mock-cleanup.ts";
import { moveModule } from "./commands/move.ts";
import { buildNamingReport } from "./commands/naming.ts";
import { renameSymbol } from "./commands/rename.ts";
import {
	applyRelocations,
	buildTestRelocationReport,
} from "./commands/test-relocation.ts";
import { applyTidyFixes, buildTidyReport } from "./commands/tidy.ts";
import { findUnusedExports } from "./commands/unused.ts";
import { isWorktreeDirty } from "./core/git.ts";
import { buildDependencyGraph } from "./core/graph.ts";
import { loadProject, resolveTsConfig } from "./core/project.ts";
import { analyzeSimilarity } from "./core/similarity.ts";
import { discoverProject } from "./core/tsconfig-discovery.ts";
import {
	isIncompleteTypeCheck,
	runTypeCheck,
	type VerificationResult,
} from "./core/verify.ts";
import { discoverWorkspace } from "./core/workspace.ts";
import type { ProjectConfig } from "./types.ts";

// ── Mutating-tool helpers ──────────────────────────────────────────

/** Structured worktree check that does NOT call process.exit on dirty. */
async function checkWorktree(
	cwd: string,
	force: boolean
): Promise<{ dirty: boolean; blocked: boolean }> {
	const dirty = await isWorktreeDirty(cwd);
	return { dirty, blocked: dirty && !force };
}

interface TypecheckDelta {
	errorsBefore: number;
	errorsAfter: number;
	newErrors: string[];
	fixedCount: number;
	/**
	 * True when either the before- or after-change tsc run failed to complete
	 * (e.g. fatal TS2688 with no per-file diagnostics). When true, the delta
	 * is not trustworthy — `errorsAfter: 0` does NOT mean the project is clean.
	 */
	verificationIncomplete: boolean;
	/**
	 * Up to 5 lines of fatal/global tsc output, present only when
	 * verificationIncomplete is true, so callers see the root cause inline.
	 */
	incompleteReason?: string[];
}

/** Run tsc before/after the mutating op and return the diagnostic delta. */
async function withTypecheckGuard<T>(
	project: ProjectConfig,
	apply: () => Promise<T>
): Promise<{ result: T; delta: TypecheckDelta }> {
	const errorsBefore = await runTypeCheck(project);
	const result = await apply();
	const errorsAfter = await runTypeCheck(project);
	const newErrors = errorsAfter.filter((e) => !errorsBefore.includes(e));
	const fixedErrors = errorsBefore.filter((e) => !errorsAfter.includes(e));
	const verificationIncomplete =
		isIncompleteTypeCheck(errorsBefore) || isIncompleteTypeCheck(errorsAfter);
	return {
		result,
		delta: {
			errorsBefore: errorsBefore.length,
			errorsAfter: errorsAfter.length,
			newErrors,
			fixedCount: fixedErrors.length,
			verificationIncomplete,
			incompleteReason: verificationIncomplete
				? errorsAfter.slice(0, 5)
				: undefined,
		},
	};
}

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
			internalUsage: e.internalUsage,
			internalRefCount: e.internalRefCount,
		})),
		noExternalUsage: result.noExternalUsage,
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
		schemaVersion: report.schemaVersion,
		totalExports: report.totalExports,
		totalFiles: report.totalFiles,
		unusedCount: report.unused.length,
		orphanFileCount: report.orphanFiles.length,
		deadCount: report.deadCount,
		internalOnlyCount: report.internalOnlyCount,
		scannedConfigs: report.scannedConfigs.map((c) =>
			path.relative(absoluteDir, c)
		),
		scannedFileCount: report.scannedFileCount,
		orphanFiles: report.orphanFiles.map((orphan) => ({
			file: path.relative(absoluteDir, orphan.file),
			exportNames: orphan.exportNames,
			externalImporterCount: orphan.externalImporterCount,
			noExternalUsage: orphan.noExternalUsage,
		})),
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

async function tidyTool(
	directory: string,
	options: {
		project?: string;
		experimental?: boolean;
		scope?: string;
		workspace?: boolean;
		dryRun?: boolean;
		force?: boolean;
		fixCategories?: Array<
			| "dead-exports"
			| "alias-normalisation"
			| "file-moves"
			| "mock-cleanup"
			| "case-renames"
			| "layout-relocations"
		>;
		maxChanges?: number;
		fanOutThreshold?: number;
		fanInThreshold?: number;
		exportThreshold?: number;
	}
): Promise<CallToolResult> {
	if (!options.experimental) {
		return errorText(
			"`tidy` is experimental in resect 1.x. Set experimental=true to opt in."
		);
	}
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}
	const report = await buildTidyReport({
		directory: absoluteDir,
		project: options.project,
		experimental: options.experimental,
		scope: options.scope,
		workspace: options.workspace,
		fanOutThreshold: options.fanOutThreshold,
		fanInThreshold: options.fanInThreshold,
		exportThreshold: options.exportThreshold,
	});
	if (dryRun) {
		return jsonText({ dryRun, force: options.force ?? false, report });
	}
	const result = await applyTidyFixes(
		report,
		{
			directory: absoluteDir,
			project: options.project,
			experimental: options.experimental,
			scope: options.scope,
			workspace: options.workspace,
			fix: true,
			fixCategories: options.fixCategories,
			force: options.force,
			maxChanges: options.maxChanges,
			fanOutThreshold: options.fanOutThreshold,
			fanInThreshold: options.fanInThreshold,
			exportThreshold: options.exportThreshold,
		},
		{ project, reportDirectory: absoluteDir }
	);
	return jsonText({
		dryRun,
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		rollbackDisabled: result.worktreeDirtyRollbackDisabled,
		success: result.success,
		errors: result.errors,
		report: result.report,
	});
}

async function namingTool(
	directory: string,
	options: {
		project?: string;
		workspace?: boolean;
		minSiblings?: number;
		majorityThreshold?: number;
		includeTests?: boolean;
		fix?: boolean;
		dryRun?: boolean;
		force?: boolean;
	}
): Promise<CallToolResult> {
	if (options.fix && !options.dryRun) {
		const { applyNamingFix } = await import("./commands/naming.ts");
		const absoluteDir = path.resolve(directory);
		const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
		if (!tsconfigPath) {
			return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
		}
		const project = loadProject(tsconfigPath, absoluteDir);
		const wt = await checkWorktree(project.rootDir, options.force ?? false);
		if (wt.blocked) {
			return errorText(
				"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
			);
		}
		const result = await applyNamingFix({
			directory: absoluteDir,
			project: options.project,
			workspace: options.workspace,
			minSiblings: options.minSiblings,
			majorityThreshold: options.majorityThreshold,
			includeTests: options.includeTests,
			fix: true,
			force: options.force,
			dryRun: false,
		});
		return jsonText(result);
	}
	const report = await buildNamingReport({
		directory,
		project: options.project,
		workspace: options.workspace,
		minSiblings: options.minSiblings,
		majorityThreshold: options.majorityThreshold,
		includeTests: options.includeTests,
	});
	return jsonText(report);
}

async function testRelocationTool(
	directory: string,
	options: {
		project?: string;
		dryRun?: boolean;
		force?: boolean;
		verbose?: boolean;
		conventionThreshold?: number;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}
	const report = await buildTestRelocationReport({
		directory: absoluteDir,
		project: options.project,
		conventionThreshold: options.conventionThreshold,
	});
	if (dryRun) {
		return jsonText({ dryRun, force: options.force ?? false, report });
	}
	const result = await applyRelocations(report, {
		project,
		reportDirectory: absoluteDir,
		dryRun,
		verbose: options.verbose,
	});
	return jsonText({
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		...result,
	});
}

async function mockCleanupTool(
	directory: string,
	options: {
		project?: string;
		dryRun?: boolean;
		force?: boolean;
		verify?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}

	const report = await buildMockCleanupReport({
		directory: absoluteDir,
		project: options.project,
	});
	if (dryRun) {
		return jsonText({ dryRun, force: options.force ?? false, report });
	}

	const result = await applyMockCleanup(report, {
		project,
		reportDirectory: absoluteDir,
		dryRun,
		verify: options.verify ?? true,
	});
	return jsonText({
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		...result,
		modifiedFiles: result.modifiedFiles.map((file) =>
			path.relative(project.rootDir, file)
		),
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
			"Find exports that no OTHER file in the project imports, plus exported files with no external usage. A per-export hit is a DE-EXPORT signal, not automatically a DELETE signal: each entry carries `internalUsage`/`internalRefCount` telling you whether the symbol is still referenced WITHIN its own file. `internalUsage:false` (`internalRefCount:0`) means referenced nowhere — safe to delete; `internalUsage:true` means only the `export` keyword is redundant — deleting the symbol would break its own module, so just drop the `export`. `orphanFiles` lists files with exports but zero external importers, excluding package entrypoints. Aliased imports (`import { a as b }`) count as cross-file usage; whole-module imports (`import *`, `export *`, dynamic `import()`, `require()`) mark every export of that module as used. Usage is counted across ALL tsconfigs discovered in the project (the scanned set is returned as `scannedConfigs`/`scannedFileCount`), so an export consumed only by a sibling config (e.g. `scripts/` on `tsconfig.scripts.json`) is not falsely reported dead. The `ignore` glob suppresses files only as reported candidates — ignored files (e.g. tests) still count as usage sources, so a test-only export is not reported dead. Returns total export/file counts, `deadCount`, `internalOnlyCount`, `orphanFiles`, `scannedConfigs`, `scannedFileCount`, and the unused list. Read-only.",
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

server.registerTool(
	"tidy",
	{
		description:
			"Run the experimental tidy orchestrator over a TypeScript project. Composes the existing unused, similar, and audit analyses into one versioned grouped report with per-category findings and a summary. Defaults to dryRun:true. When dryRun:false, applies safe fixes, refuses a dirty worktree unless force:true, runs type checking after the batch, and rolls back on new errors or incomplete verification.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			experimental: z
				.boolean()
				.optional()
				.describe("Required opt-in while tidy is experimental in resect 1.x"),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			scope: z
				.string()
				.optional()
				.describe(
					"Only return findings whose source file is under this subtree"
				),
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across all workspace packages where supported"),
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview only by default; set false to apply tidy fixes"),
			force: z
				.boolean()
				.optional()
				.describe("Allow mutation when the git worktree is dirty"),
			fixCategories: z
				.array(
					z.enum([
						"dead-exports",
						"alias-normalisation",
						"file-moves",
						"mock-cleanup",
						"case-renames",
						"layout-relocations",
					])
				)
				.optional()
				.describe(
					"Fix categories to apply. Omit for safe defaults: dead-exports and alias-normalisation"
				),
			maxChanges: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Abort mutation if planned changes exceed this limit"),
			fanOutThreshold: z
				.number()
				.optional()
				.describe("Flag files importing more than N distinct modules"),
			fanInThreshold: z
				.number()
				.optional()
				.describe("Flag files imported by more than N distinct files"),
			exportThreshold: z
				.number()
				.optional()
				.describe("Flag files exporting more than N symbols"),
		},
	},
	async ({
		directory,
		experimental,
		project,
		scope,
		workspace,
		dryRun,
		force,
		fixCategories,
		maxChanges,
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	}) => {
		try {
			return await tidyTool(directory, {
				experimental,
				project,
				scope,
				workspace,
				dryRun,
				force,
				fixCategories,
				maxChanges,
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
	"naming",
	{
		description:
			"Audit per-directory filename casing conventions and report files whose basename casing is an outlier not justified by the primary export kind. Groups files by directory, finds a casing majority across camelCase, PascalCase, kebab-case, and snake_case, and returns suggested filenames plus confidence. When fix=true and dryRun=false, applies safe case-only renames via the move pipeline, runs a closing tsc --noEmit gate, and rolls back on new type errors. Mutating when fix=true and dryRun=false; read-only otherwise.",
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
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across workspace packages where available"),
			minSiblings: z
				.number()
				.optional()
				.describe("Minimum files in a directory before auditing (default 3)"),
			majorityThreshold: z
				.number()
				.optional()
				.describe(
					"Required majority ratio from 0.0 to 1.0 before reporting outliers (default 0.6)"
				),
			includeTests: z
				.boolean()
				.optional()
				.describe("Include *.test.* and *.spec.* files in the audit"),
			fix: z
				.boolean()
				.optional()
				.describe(
					"Apply renames for all flagged files. Defaults to false (read-only). Requires a clean git worktree unless force=true."
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"When fix=true, preview planned renames without writing files (default true for MCP safety)"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Bypass the dirty-worktree guard when fix=true. Rollback is disabled when force=true on a dirty tree."
				),
		},
	},
	async ({
		directory,
		project,
		workspace,
		minSiblings,
		majorityThreshold,
		includeTests,
		fix,
		dryRun,
		force,
	}) => {
		try {
			return await namingTool(directory, {
				project,
				workspace,
				minSiblings,
				majorityThreshold,
				includeTests,
				fix,
				dryRun: fix ? (dryRun ?? true) : undefined,
				force,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"test-relocation",
	{
		description:
			"Find test files whose imports indicate they are stranded away from their subject module or misnamed relative to the subject they import. Defaults to dryRun=true and returns suggested moves. When dryRun=false, moves each test through the existing move pipeline, then runs one closing typecheck and rolls back on regression. Mutating.",
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
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview relocations without writing files (default true)"),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra move detail where available"),
			conventionThreshold: z
				.number()
				.optional()
				.describe(
					"Required __tests__ majority ratio from 0.0 to 1.0 before suggesting __tests__ placement (default 0.7)"
				),
		},
	},
	async ({
		directory,
		project,
		dryRun,
		force,
		verbose,
		conventionThreshold,
	}) => {
		try {
			return await testRelocationTool(directory, {
				project,
				dryRun,
				force,
				verbose,
				conventionThreshold,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"mock-cleanup",
	{
		description:
			"Detect orphan keys in jest.mock, vi.mock, vitest.mock, and bun:test mock.module object-literal factories. Defaults to dryRun=true and reports keys whose names are no longer exports on the mocked module, plus skipped factories such as spread or computed shapes. When dryRun=false, removes only those orphan keys, leaves the mock call in place even if the factory becomes empty, runs tsc before/after by default, and rolls back on typecheck regression. Mutating.",
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
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview orphan mock keys without writing files (default true)"
				),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and roll back on regression (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ directory, project, dryRun, force, verify }) => {
		try {
			return await mockCleanupTool(directory, {
				project,
				dryRun,
				force,
				verify,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

// ── Mutating tool implementations ──────────────────────────────────

async function moveTool(args: {
	source: string;
	target: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
	verbose: boolean;
}): Promise<CallToolResult> {
	const absoluteSource = path.resolve(args.source);
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(
		args.project,
		path.dirname(absoluteSource)
	);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteSource}`);
	}
	const project = loadProject(tsconfigPath, absoluteSource);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}

	const workspace = (await discoverWorkspace(project.rootDir)) ?? undefined;

	const runMove = async () =>
		moveModule(
			absoluteSource,
			absoluteTarget,
			project,
			args.dryRun,
			args.verbose,
			workspace
		);

	const shouldVerify = args.verify && !args.dryRun;
	const { result, delta } = shouldVerify
		? await withTypecheckGuard(project, runMove)
		: { result: await runMove(), delta: undefined };

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.success,
		movedFile: {
			from: path.relative(root, result.movedFile.from),
			to: path.relative(root, result.movedFile.to),
		},
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
			recoverable: e.recoverable,
		})),
		typecheck: delta,
	});
}

async function renameTool(args: {
	file: string;
	oldName: string;
	newName: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
	verbose: boolean;
}): Promise<CallToolResult> {
	const absolutePath = path.resolve(args.file);
	const tsconfigPath = resolveTsConfig(
		args.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absolutePath}`);
	}
	const project = loadProject(tsconfigPath, absolutePath);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}

	const runRename = async () =>
		renameSymbol(
			absolutePath,
			args.oldName,
			args.newName,
			project,
			args.dryRun,
			args.verbose
		);

	const shouldVerify = args.verify && !args.dryRun;
	const { result, delta } = shouldVerify
		? await withTypecheckGuard(project, runRename)
		: { result: await runRename(), delta: undefined };

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.success,
		renamedSymbol: {
			file: path.relative(root, result.renamedSymbol.file),
			oldName: result.renamedSymbol.oldName,
			newName: result.renamedSymbol.newName,
		},
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
		})),
		typecheck: delta,
	});
}

function verificationToDelta(result: VerificationResult): TypecheckDelta {
	return {
		errorsBefore: result.errorsBefore.length,
		errorsAfter: result.errorsAfter.length,
		newErrors: result.newErrors,
		fixedCount: result.fixedErrors.length,
		verificationIncomplete: result.verificationIncomplete,
		incompleteReason: result.verificationIncomplete
			? result.errorsAfter.slice(0, 5)
			: undefined,
	};
}

async function aliasTool(args: {
	target: string;
	prefer?: "alias" | "relative" | "shortest";
	renameSpecifiers?: string[];
	project?: string;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
}): Promise<CallToolResult> {
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(args.project, absoluteTarget);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteTarget}`);
	}
	const project = loadProject(tsconfigPath);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(
			"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true."
		);
	}

	const renames = parseSpecifierRenames(args.renameSpecifiers ?? []);
	if (renames.length === 0 && !args.prefer) {
		return errorText("alias requires either prefer or renameSpecifiers");
	}
	const result: AliasResult =
		renames.length > 0
			? renameImportSpecifiers(absoluteTarget, renames, project)
			: normalizeImports(absoluteTarget, args.prefer ?? "alias", project);

	let delta: TypecheckDelta | undefined;
	let rolledBack = false;
	if (
		!args.dryRun &&
		result.changes.length > 0 &&
		result.conflicts.length === 0
	) {
		if (args.verify && renames.length > 0) {
			const verification = await applyAliasChangesWithVerification(
				result.changes,
				project
			);
			delta = verificationToDelta(verification);
			rolledBack = !verification.success;
		} else {
			const guarded = args.verify
				? await withTypecheckGuard(project, async () =>
						applyAliasChanges(result.changes)
					)
				: { delta: undefined };
			delta = guarded.delta;
			if (!args.verify) {
				await applyAliasChanges(result.changes);
			}
		}
	}

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.conflicts.length === 0 && !rolledBack,
		strategy: renames.length > 0 ? "rename-specifier" : args.prefer,
		rolledBack,
		filesProcessed: result.filesProcessed,
		importsUpdated: result.importsUpdated,
		changes: result.changes.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			strategy: c.strategy,
		})),
		conflicts: result.conflicts.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			reason: c.reason,
		})),
		typecheck: delta,
	});
}

// ── Mutating tool registrations ────────────────────────────────────

server.registerTool(
	"move",
	{
		description:
			"Move a TypeScript/JavaScript file to a new path and rewrite every import that referenced it. Updates relative and alias specifiers, splits mixed barrel imports when only some bindings moved, updates barrel re-exports for same-package moves, and rewrites cross-package imports to use the destination package name (adding a barrel export at the destination when needed). Defaults to `dryRun: true` so callers preview the change first; when `dryRun: false` and `verify: true` (both default) the tool runs `tsc --noEmit` before AND after the move and returns the diagnostic delta in `typecheck` — `newErrors` lists any errors the move introduced. A dirty worktree is returned as an error unless `force: true`. Returns success flag, updated reference list, errors, worktree-dirty flag, and (when verified) the typecheck delta.",
		inputSchema: {
			source: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the existing file to move (e.g. 'src/old/foo.ts')"
				),
			target: z
				.string()
				.describe(
					"Absolute or cwd-relative path the file should be moved to (e.g. 'src/new/foo.ts'). Must not already exist"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the move without writing files (default true). Set false to actually apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after the move and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
		},
	},
	async ({ source, target, project, dryRun, force, verify, verbose }) => {
		try {
			return await moveTool({
				source,
				target,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
				verbose: verbose ?? false,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"rename",
	{
		description:
			"Rename an exported symbol (function, class, type, interface, enum, const) in its source file and update every import that references it across the project. Updates both the declaration and all unaliased import bindings; aliased imports (`import { foo as bar }`) are left intact because the local name is already decoupled. Checks for conflicts before mutating: aborts if the new name already exists in the source file or in any importing file's local bindings. Defaults to `dryRun: true`; when `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta. A dirty worktree is returned as an error unless `force: true`. Returns success, updated reference list, errors, worktree-dirty flag, and (when verified) the typecheck delta.",
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the source file that declares the export to rename"
				),
			oldName: z
				.string()
				.describe(
					"Current name of the exported symbol (must exist as an export in `file`)"
				),
			newName: z
				.string()
				.describe(
					"New name for the export. Must not already exist in the source file or in any importing file's bindings"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rename without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
		},
	},
	async ({
		file,
		oldName,
		newName,
		project,
		dryRun,
		force,
		verify,
		verbose,
	}) => {
		try {
			return await renameTool({
				file,
				oldName,
				newName,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
				verbose: verbose ?? false,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

server.registerTool(
	"alias",
	{
		description:
			"Normalize import specifiers across a file or directory to a chosen style, or rewrite exact specifier strings with `renameSpecifiers` for case-only alias moves. Strategies: `alias` rewrites relative paths to tsconfig `paths` aliases where available; `relative` rewrites alias paths to `./…` relative paths; `shortest` picks whichever resulting specifier is shorter per import. `renameSpecifiers` accepts repeated `<from>=<to>` strings and skips normalization logic. Defaults to `dryRun: true`; when `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta. A dirty worktree is returned as an error unless `force: true`. Returns the strategy used, files processed, import count updated, conflicts, the per-change list, and (when verified) the typecheck delta.",
		inputSchema: {
			target: z
				.string()
				.describe(
					"Absolute or cwd-relative path to a file or directory whose imports should be normalized"
				),
			prefer: z
				.enum(["alias", "relative", "shortest"])
				.optional()
				.describe(
					"Normalization strategy: 'alias' = use tsconfig paths, 'relative' = use ./ paths, 'shortest' = pick the shorter option per import. Required unless renameSpecifiers is provided"
				),
			renameSpecifiers: z
				.array(z.string())
				.optional()
				.describe(
					"Exact specifier rewrite pairs in '<from>=<to>' form, for example '@utils/Foo=@utils/foo'. When provided, normalization strategy is skipped"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rewrite without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({
		target,
		prefer,
		renameSpecifiers,
		project,
		dryRun,
		force,
		verify,
	}) => {
		try {
			return await aliasTool({
				target,
				prefer,
				renameSpecifiers,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
			});
		} catch (error) {
			return toError(error);
		}
	}
);

async function extractCommonTool(args: {
	directory: string;
	project?: string;
	threshold?: number;
	group?: number;
	output?: string;
	workspace: boolean;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	skipSameFile?: boolean;
	minLines?: number;
	skipDirectives?: boolean;
	skipWrappers?: boolean;
}): Promise<CallToolResult> {
	const absoluteDir = path.resolve(args.directory);
	const tsconfigPath = resolveTsConfig(args.project, absoluteDir);
	if (!tsconfigPath) {
		return errorText(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const project = loadProject(tsconfigPath);

	const runExtract = async () =>
		runExtractCommon({
			directory: absoluteDir,
			project: args.project,
			threshold: args.threshold,
			group: args.group,
			output: args.output,
			workspace: args.workspace,
			dryRun: args.dryRun,
			force: args.force,
			nameThreshold: args.nameThreshold,
			sameNameOnly: args.sameNameOnly,
			skipSameFile: args.skipSameFile,
			minLines: args.minLines,
			skipDirectives: args.skipDirectives,
			skipWrappers: args.skipWrappers,
		});

	const shouldVerify = args.verify && !args.dryRun;
	type Result = Awaited<ReturnType<typeof runExtractCommon>>;
	const guarded: { result: Result; delta: TypecheckDelta | undefined } =
		shouldVerify
			? await withTypecheckGuard(project, runExtract)
			: { result: await runExtract(), delta: undefined };
	const { result, delta } = guarded;

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: result.worktreeDirty,
		success: result.success,
		totalGroups: result.totalGroups,
		totalRemoved: result.totalRemoved,
		modifiedFiles: result.modifiedFiles.map((f) => path.relative(root, f)),
		groups: result.groups.map((g) => ({
			canonical: {
				file: path.relative(root, g.canonical.file),
				line: g.canonical.line,
				name: g.canonical.name,
			},
			removed: g.removed.map((r) => ({
				file: path.relative(root, r.file),
				line: r.line,
				name: r.name,
			})),
			functions: g.functions.map((f) => ({
				file: path.relative(root, f.file),
				line: f.line,
				name: f.name,
			})),
		})),
		errors: result.errors,
		typecheck: delta,
	});
}

server.registerTool(
	"extract-common",
	{
		description:
			"Consolidate duplicate or near-duplicate top-level functions across a project by extracting one canonical copy and removing the rest. Internally runs `similar` to find groups, picks a canonical per group, removes the others, and rewrites their callers' imports to reference the canonical's location (or a shared `output` file when provided). Defaults to `dryRun: true` — preview the extraction plan first. When `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta in `typecheck`. A dirty worktree is returned as an error unless `force: true`. Returns success flag, total groups extracted, total duplicates removed, modified file list, per-group plan (canonical + removed + all functions), errors, worktree-dirty flag, and (when verified) the typecheck delta. Skips groups that would create circular imports.",
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan and refactor"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			threshold: z
				.number()
				.optional()
				.describe(
					"Minimum structural similarity to consider for extraction, 0.0–1.0 (default 0.95). Lower = consolidate more loosely-similar functions"
				),
			group: z
				.number()
				.optional()
				.describe(
					"Restrict extraction to a single group by 1-based index from the similar report. Useful for piloting one consolidation at a time"
				),
			output: z
				.string()
				.optional()
				.describe(
					"Path to a shared file where the canonical function should be written (e.g. 'src/shared/helpers.ts'). When omitted, the canonical stays in place at its current file"
				),
			workspace: z
				.boolean()
				.optional()
				.describe(
					"Scan across all packages in a workspace (default false). Required for cross-package consolidation"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the extraction without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			nameThreshold: z
				.number()
				.optional()
				.describe(
					"Also require member NAME similarity (0.0–1.0) to group functions together"
				),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe(
					"Only consolidate functions that share an identical name (strictest grouping)"
				),
			skipSameFile: z
				.boolean()
				.optional()
				.describe(
					"Skip groups whose members all live in one file, leaving only cross-file duplication"
				),
			minLines: z
				.number()
				.optional()
				.describe(
					"Ignore functions whose body has fewer than N lines, to skip trivial one-liners"
				),
			skipDirectives: z
				.boolean()
				.optional()
				.describe(
					"Skip functions with compile-time directives (e.g. 'use server', 'use client') that change runtime semantics"
				),
			skipWrappers: z
				.boolean()
				.optional()
				.describe(
					"Skip thin wrapper functions whose body is a single delegating call"
				),
		},
	},
	async ({
		directory,
		project,
		threshold,
		group,
		output,
		workspace,
		dryRun,
		force,
		verify,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		minLines,
		skipDirectives,
		skipWrappers,
	}) => {
		try {
			return await extractCommonTool({
				directory,
				project,
				threshold,
				group,
				output,
				workspace: workspace ?? false,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
				nameThreshold,
				sameNameOnly,
				skipSameFile,
				minLines,
				skipDirectives,
				skipWrappers,
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
