import path from "node:path";
import { logger } from "../cli-logger.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import type { SimilarityGroup, SimilarityReport } from "../types.ts";

export interface SimilarOptions {
	directory: string;
	project?: string;
	json?: boolean;
	threshold?: number;
	maxGroups?: number;
	strict?: boolean;
	workspace?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	skipSameFile?: boolean;
	onlyRelatedTo?: string;
}

export async function similarCommand(options: SimilarOptions): Promise<void> {
	const {
		directory,
		project,
		json,
		threshold = 0.8,
		maxGroups = 10,
		strict = false,
		workspace = false,
		nameThreshold,
		sameNameOnly = false,
		skipSameFile = false,
		onlyRelatedTo,
	} = options;
	const absoluteDir = path.resolve(directory);

	if (!json) {
		const mode = workspace ? "across workspace packages" : "in";
		logger.info(`\n🔍 Scanning for similar functions ${mode} ${absoluteDir}\n`);
	}

	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		projectRoot: project,
		workspace,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
	});

	if (json) {
		const output =
			maxGroups > 0
				? {
						...report,
						groups: report.groups.slice(0, maxGroups),
						totalGroups: report.groups.length,
						truncated: report.groups.length > maxGroups,
					}
				: { ...report, totalGroups: report.groups.length, truncated: false };
		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		if (strict && report.groups.length > 0) {
			process.stderr.write(
				`error: ${report.groups.length} similar function group(s) found (threshold: ${threshold})\n`
			);
			process.exit(1);
		}
		return;
	}

	printReport(report, absoluteDir, maxGroups);

	if (strict && report.groups.length > 0) {
		logger.error(
			`\nerror: ${report.groups.length} similar function group(s) found (threshold: ${threshold})`
		);
		process.exit(1);
	}
}

function bucketInfo(group: SimilarityGroup): { icon: string; label: string } {
	const pct = `${(group.score * 100).toFixed(0)}%`;
	switch (group.bucket) {
		case "exact":
			return { icon: "🔴", label: "exact duplicate (after normalization)" };
		case "high":
			return { icon: "🟠", label: `high similarity (${pct})` };
		case "medium":
			return { icon: "🟡", label: `medium similarity (${pct})` };
		default:
			return { icon: "⚪", label: `similarity (${pct})` };
	}
}

function printReport(
	report: SimilarityReport,
	baseDir: string,
	maxGroups: number
): void {
	logger.info(
		`📊 Scanned ${report.totalFunctions} function(s) across ${report.totalFiles} file(s)\n`
	);

	if (report.groups.length === 0) {
		logger.info("✅ No similar functions found.");
		logger.empty();
		return;
	}

	const totalGroups = report.groups.length;
	const groups =
		maxGroups > 0 ? report.groups.slice(0, maxGroups) : report.groups;

	logger.info(`Found ${totalGroups} candidate group(s) for consolidation:\n`);

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		if (!group) {
			continue;
		}
		const { icon, label } = bucketInfo(group);

		logger.info(`${icon} Group ${i + 1}: ${label}`);

		for (const fn of group.functions) {
			const rel = path.relative(baseDir, fn.file);
			logger.info(`   • ${fn.name}  ${rel}:${fn.line}`);
		}

		logger.empty();
	}

	if (maxGroups > 0 && totalGroups > maxGroups) {
		logger.info(
			`… ${totalGroups - maxGroups} more group(s) not shown. Use --max-groups=0 to show all.\n`
		);
	}

	// Suggest extract-common commands
	const dir = path.relative(process.cwd(), baseDir) || ".";
	logger.info("💡 To extract duplicates, run:");
	logger.info(`   resect extract-common ${dir} --dry-run`);
	if (totalGroups > 1) {
		logger.info(
			`   resect extract-common ${dir} --group=1 --dry-run  # target a specific group`
		);
	}
	logger.empty();
}
