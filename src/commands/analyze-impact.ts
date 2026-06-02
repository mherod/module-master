import path from "node:path";
import { logger } from "../cli-logger.ts";
import type { ImpactReport } from "../types/impact.ts";
import type { ReadOnlyCommandOptions } from "../types.ts";

export interface AnalyzeImpactOptions extends ReadOnlyCommandOptions {
	/** File proposed to move/rename. */
	source: string;
	/** Proposed destination path. */
	target: string;
}

/**
 * Compute the read-only impact radius of a proposed `move`/`rename`.
 *
 * Scaffold slice (#114): resolves the paths and returns a typed stub —
 * zero counts, empty deps, `"low"` risk. The real graph composition
 * (direct/indirect importers, boundary crossings, missing deps) lands in
 * the engine sub-issue (#115) and risk scoring in (#116); both build on
 * this `ImpactReport` shape. Side-effect free — safe to call speculatively.
 */
export function analyzeImpact(options: AnalyzeImpactOptions): ImpactReport {
	return {
		source: path.resolve(options.source),
		target: path.resolve(options.target),
		impactedFilesCount: 0,
		boundaryCrossedCount: 0,
		breakingRisk: "low",
		missingDependencies: [],
	};
}

export function analyzeImpactCommand(options: AnalyzeImpactOptions): void {
	const report = analyzeImpact(options);
	printImpact(report, options.verbose);
}

function printImpact(report: ImpactReport, verbose?: boolean): void {
	logger.info(
		`\n🎯 Impact: ${path.basename(report.source)} → ${path.basename(report.target)}`
	);
	if (verbose) {
		logger.info(`   source: ${report.source}`);
		logger.info(`   target: ${report.target}`);
	}
	logger.empty();
	logger.info(`   Impacted files:     ${report.impactedFilesCount}`);
	logger.info(`   Boundaries crossed: ${report.boundaryCrossedCount}`);
	logger.info(`   Breaking risk:      ${report.breakingRisk}`);
	logger.info(
		`   Missing deps:       ${report.missingDependencies.length === 0 ? "(none)" : report.missingDependencies.join(", ")}`
	);
	logger.empty();
	logger.info(
		"ℹ️  Impact computation is not yet implemented (scaffold #114). The engine lands in #99's sub-issues."
	);
}
