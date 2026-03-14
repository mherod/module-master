import path from "node:path";
import { logger } from "../cli-logger.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import type { SimilarityGroup, SimilarityReport } from "../types.ts";

export interface SimilarOptions {
	directory: string;
	project?: string;
	json?: boolean;
	threshold?: number;
	workspace?: boolean;
}

export async function similarCommand(options: SimilarOptions): Promise<void> {
	const {
		directory,
		project,
		json,
		threshold = 0.7,
		workspace = false,
	} = options;
	const absoluteDir = path.resolve(directory);

	if (!json) {
		const mode = workspace ? "across workspace packages" : "in";
		logger.info(`\n🔍 Scanning for similar functions ${mode} ${absoluteDir}\n`);
	}

	const report = await analyzeSimilarity(
		absoluteDir,
		threshold,
		project,
		workspace
	);

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	printReport(report, absoluteDir);
}

function bucketLabel(group: SimilarityGroup): string {
	switch (group.bucket) {
		case "exact":
			return "exact duplicate (after normalization)";
		case "high":
			return `high similarity (${(group.score * 100).toFixed(0)}%)`;
		case "medium":
			return `medium similarity (${(group.score * 100).toFixed(0)}%)`;
		default:
			return `similarity (${(group.score * 100).toFixed(0)}%)`;
	}
}

function bucketIcon(group: SimilarityGroup): string {
	switch (group.bucket) {
		case "exact":
			return "🔴";
		case "high":
			return "🟠";
		case "medium":
			return "🟡";
		default:
			return "⚪";
	}
}

function printReport(report: SimilarityReport, baseDir: string): void {
	logger.info(
		`📊 Scanned ${report.totalFunctions} function(s) across ${report.totalFiles} file(s)\n`
	);

	if (report.groups.length === 0) {
		logger.info("✅ No similar functions found.");
		logger.empty();
		return;
	}

	logger.info(
		`Found ${report.groups.length} candidate group(s) for consolidation:\n`
	);

	for (let i = 0; i < report.groups.length; i++) {
		const group = report.groups[i];
		if (!group) {
			continue;
		}
		const icon = bucketIcon(group);
		const label = bucketLabel(group);

		logger.info(`${icon} Group ${i + 1}: ${label}`);

		for (const fn of group.functions) {
			const rel = path.relative(baseDir, fn.file);
			logger.info(`   • ${fn.name}  ${rel}:${fn.line}`);
		}

		logger.empty();
	}
}
