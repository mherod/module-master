import path from "node:path";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import {
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import { resolveTsConfig } from "../core/project.ts";
import {
	collectFunctionsFromFiles,
	findSimilarGroups,
	type SimilarityFilterOptions,
} from "../core/similarity.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import type {
	TidyAuditFinding,
	TidyOptions,
	TidyReport,
	TidySimilarFinding,
	TidySimilarMember,
	TidyUnusedFinding,
} from "../types/tidy.ts";
import { buildAuditReport, type FileMetrics } from "./audit.ts";
import {
	findUnusedExportsFromGraphs,
	type ProjectGraphResult,
} from "./unused.ts";

const TIDY_SCHEMA_VERSION = "1-experimental" as const;
const DEFAULT_FAN_OUT_THRESHOLD = 10;
const DEFAULT_FAN_IN_THRESHOLD = 10;
const DEFAULT_EXPORT_THRESHOLD = 8;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

function assertExperimental(enabled: boolean | undefined): void {
	if (enabled) {
		return;
	}
	throw new Error(
		"`tidy` is experimental in resect 1.x. Re-run with --experimental to opt in."
	);
}

function isWithin(baseDir: string, filePath: string): boolean {
	const relative = path.relative(baseDir, filePath);
	return (
		relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
	);
}

function toRelative(baseDir: string, filePath: string): string {
	return path.relative(baseDir, filePath) || ".";
}

function firstScopedFile(
	files: string[],
	scopeDir: string
): string | undefined {
	return files.find((file) => isWithin(scopeDir, file));
}

function buildMergedGraph(graphs: ProjectGraphResult[]): DependencyGraph {
	return mergeDependencyGraphs(graphs.map(({ graph }) => graph));
}

function dedupeGraphs(graphs: ProjectGraphResult[]): ProjectGraphResult[] {
	const seen = new Set<string>();
	const deduped: ProjectGraphResult[] = [];
	for (const graph of graphs) {
		const key = path.resolve(graph.tsconfigPath);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(graph);
	}
	return deduped;
}

async function buildGraphSet(options: {
	tsconfigPath: string;
	reportDirectory: string;
	project?: string;
	workspace?: boolean;
}): Promise<{ graphs: ProjectGraphResult[]; scanDirectory: string }> {
	const baseGraphs = await buildProjectGraphs(options.tsconfigPath);
	if (!options.workspace) {
		return { graphs: baseGraphs, scanDirectory: options.reportDirectory };
	}

	const workspaceDir = options.project
		? path.resolve(options.project)
		: options.reportDirectory;
	const workspace = await discoverWorkspace(workspaceDir);
	if (!workspace || workspace.packages.length === 0) {
		return { graphs: baseGraphs, scanDirectory: options.reportDirectory };
	}
	if (
		filterToWorkspaceBoundary([options.reportDirectory], workspace.root)
			.length === 0
	) {
		throw new Error(`Directory is outside workspace root: ${workspace.root}`);
	}

	const packageGraphs = await mapConcurrent(
		workspace.packages.filter((pkg) => pkg.tsconfigPath),
		async (pkg) => await buildProjectGraphs(pkg.tsconfigPath as string),
		{ onError: () => [] as ProjectGraphResult[] }
	);

	return {
		graphs: dedupeGraphs([...baseGraphs, ...packageGraphs.flat()]),
		scanDirectory: workspace.root,
	};
}

function graphFiles(graph: DependencyGraph, directory: string): string[] {
	return Array.from(graph.imports.keys()).filter(
		(file) => TS_JS_VUE_EXTENSIONS.test(file) && isWithin(directory, file)
	);
}

async function mapUnusedFindings(
	graphs: ProjectGraphResult[],
	scanDirectory: string,
	reportDirectory: string,
	scopeDir: string
): Promise<{ findings: TidyUnusedFinding[]; totalFiles: number }> {
	const report = await findUnusedExportsFromGraphs(scanDirectory, graphs);
	return {
		totalFiles: report.totalFiles,
		findings: report.unused
			.filter((finding) => isWithin(scopeDir, finding.file))
			.map((finding) => ({
				kind: "unused",
				sourceFile: toRelative(reportDirectory, finding.file),
				name: finding.name,
				line: finding.line,
				exportKind: finding.type,
				isType: finding.isType,
				internalUsage: finding.internalUsage,
				internalRefCount: finding.internalRefCount,
			})),
	};
}

async function mapSimilarFindings(options: {
	graph: DependencyGraph;
	scanDirectory: string;
	reportDirectory: string;
	scopeDir: string;
}): Promise<{ findings: TidySimilarFinding[]; totalFiles: number }> {
	const files = graphFiles(options.graph, options.scanDirectory);
	const { functions, totalFiles } = await collectFunctionsFromFiles(files);
	const filterOptions: SimilarityFilterOptions = {
		threshold: DEFAULT_SIMILARITY_THRESHOLD,
	};
	const groups = findSimilarGroups(functions, filterOptions);
	const findings: TidySimilarFinding[] = [];

	for (let index = 0; index < groups.length; index++) {
		const group = groups[index];
		if (!group) {
			continue;
		}
		const scopedSource = firstScopedFile(
			group.functions.map((member) => member.file),
			options.scopeDir
		);
		if (!scopedSource) {
			continue;
		}
		const members: TidySimilarMember[] = group.functions.map((member) => ({
			sourceFile: toRelative(options.reportDirectory, member.file),
			name: member.name,
			kind: member.kind,
			line: member.line,
		}));
		findings.push({
			kind: "similar",
			sourceFile: toRelative(options.reportDirectory, scopedSource),
			groupIndex: index + 1,
			bucket: group.bucket,
			score: group.score,
			members,
		});
	}

	return { findings, totalFiles };
}

function metricFinding(
	kind: "audit-fan-out" | "audit-fan-in" | "audit-export-surface",
	metric: FileMetrics,
	threshold: number,
	value: number,
	reportDirectory: string
): TidyAuditFinding {
	return {
		kind,
		sourceFile: toRelative(reportDirectory, metric.file),
		value,
		threshold,
		instability: metric.instability,
	};
}

function mapAuditFindings(options: {
	graph: DependencyGraph;
	reportDirectory: string;
	scopeDir: string;
	fanOutThreshold: number;
	fanInThreshold: number;
	exportThreshold: number;
}): { findings: TidyAuditFinding[]; totalFiles: number } {
	const report = buildAuditReport(options.graph, {
		fanOutThreshold: options.fanOutThreshold,
		fanInThreshold: options.fanInThreshold,
		exportThreshold: options.exportThreshold,
	});
	const findings: TidyAuditFinding[] = [];

	for (const cycle of report.cycles) {
		const scopedSource = firstScopedFile(cycle.files, options.scopeDir);
		if (!scopedSource) {
			continue;
		}
		findings.push({
			kind: "audit-cycle",
			sourceFile: toRelative(options.reportDirectory, scopedSource),
			files: cycle.files.map((file) =>
				toRelative(options.reportDirectory, file)
			),
		});
	}

	for (const metric of report.highFanOut) {
		if (isWithin(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-fan-out",
					metric,
					options.fanOutThreshold,
					metric.fanOut,
					options.reportDirectory
				)
			);
		}
	}

	for (const metric of report.highFanIn) {
		if (isWithin(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-fan-in",
					metric,
					options.fanInThreshold,
					metric.fanIn,
					options.reportDirectory
				)
			);
		}
	}

	for (const metric of report.largeExportSurface) {
		if (isWithin(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-export-surface",
					metric,
					options.exportThreshold,
					metric.exportCount,
					options.reportDirectory
				)
			);
		}
	}

	return { findings, totalFiles: report.totalFiles };
}

export async function buildTidyReport(
	options: TidyOptions
): Promise<TidyReport> {
	const reportDirectory = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}

	const { graphs, scanDirectory } = await buildGraphSet({
		tsconfigPath,
		reportDirectory,
		project: options.project,
		workspace: options.workspace,
	});
	const scopeDir = options.scope ? path.resolve(options.scope) : scanDirectory;
	const graph = buildMergedGraph(graphs);
	const [unused, similar] = await Promise.all([
		mapUnusedFindings(graphs, scanDirectory, reportDirectory, scopeDir),
		mapSimilarFindings({ graph, scanDirectory, reportDirectory, scopeDir }),
	]);
	const audit = mapAuditFindings({
		graph,
		reportDirectory,
		scopeDir,
		fanOutThreshold: options.fanOutThreshold ?? DEFAULT_FAN_OUT_THRESHOLD,
		fanInThreshold: options.fanInThreshold ?? DEFAULT_FAN_IN_THRESHOLD,
		exportThreshold: options.exportThreshold ?? DEFAULT_EXPORT_THRESHOLD,
	});
	const categories = {
		unused: unused.findings.length,
		similar: similar.findings.length,
		audit: audit.findings.length,
	};

	return {
		schemaVersion: TIDY_SCHEMA_VERSION,
		directory: toRelative(process.cwd(), reportDirectory),
		scope: options.scope ? toRelative(process.cwd(), scopeDir) : null,
		generatedAt: new Date().toISOString(),
		findings: {
			unused: unused.findings,
			similar: similar.findings,
			audit: audit.findings,
		},
		summary: {
			totalFindings: categories.unused + categories.similar + categories.audit,
			filesTouched: 0,
			categories,
			scanned: {
				unusedFiles: unused.totalFiles,
				similarFiles: similar.totalFiles,
				auditFiles: audit.totalFiles,
			},
		},
	};
}

function formatScore(score: number): string {
	return `${Math.round(score * 100)}%`;
}

export function formatTidyReport(report: TidyReport): string {
	const lines: string[] = [
		`Tidy Report (${report.directory})`,
		`Schema: ${report.schemaVersion}`,
		`Summary: ${report.summary.totalFindings} finding(s), ${report.summary.filesTouched} files touched`,
	];
	if (report.scope) {
		lines.push(`Scope: ${report.scope}`);
	}
	lines.push("");

	lines.push(`Unused exports (${report.findings.unused.length})`);
	if (report.findings.unused.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.unused) {
			const action = finding.internalUsage ? "de-export" : "delete";
			lines.push(
				`  - ${finding.sourceFile}:${finding.line} ${finding.name} (${action})`
			);
		}
	}
	lines.push("");

	lines.push(`Similar declarations (${report.findings.similar.length})`);
	if (report.findings.similar.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.similar) {
			lines.push(
				`  - Group ${finding.groupIndex} ${finding.bucket} ${formatScore(finding.score)}`
			);
			for (const member of finding.members) {
				lines.push(
					`    ${member.sourceFile}:${member.line} ${member.name} (${member.kind})`
				);
			}
		}
	}
	lines.push("");

	lines.push(`Module health (${report.findings.audit.length})`);
	if (report.findings.audit.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.audit) {
			if (finding.kind === "audit-cycle") {
				lines.push(
					`  - ${finding.sourceFile} cycle: ${finding.files.join(" -> ")}`
				);
				continue;
			}
			lines.push(
				`  - ${finding.sourceFile} ${finding.kind.replace("audit-", "")}: ${finding.value} > ${finding.threshold} (instability ${finding.instability})`
			);
		}
	}
	lines.push("");

	return `${lines.join("\n")}\n`;
}

export async function tidyCommand(options: TidyOptions): Promise<void> {
	assertExperimental(options.experimental);
	const report = await buildTidyReport(options);
	const output = options.json
		? `${JSON.stringify(report, null, 2)}\n`
		: formatTidyReport(report);

	if (options.out) {
		await Bun.write(path.resolve(options.out), output);
		if (options.verbose) {
			logger.info(`Wrote tidy report to ${path.resolve(options.out)}`);
		}
		return;
	}

	process.stdout.write(output);
}
