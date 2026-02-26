import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	discoverWorkspace,
	printWorkspaceInfo,
	type WorkspaceInfo,
} from "../core/workspace.ts";

export interface WorkspaceOptions {
	directory: string;
	verbose?: boolean;
	json?: boolean;
}

export async function workspaceCommand(
	options: WorkspaceOptions
): Promise<void> {
	const { directory, verbose = false, json = false } = options;
	const absoluteDir = path.resolve(directory);

	const workspace = await discoverWorkspace(absoluteDir);

	if (!workspace) {
		logger.error("❌ No workspace found. Looking for:");
		logger.error("   - pnpm-workspace.yaml");
		logger.error("   - package.json with 'workspaces' field");
		process.exit(1);
	}

	if (json) {
		logger.info(JSON.stringify(workspace, null, 2));
		return;
	}

	printWorkspaceInfo(workspace);

	if (verbose) {
		printDetailedPackageInfo(workspace);
	}
}

function printDetailedPackageInfo(workspace: WorkspaceInfo): void {
	logger.info("\n📋 Package Details:\n");

	for (const pkg of workspace.packages) {
		logger.info(`━━━ ${pkg.name} ━━━`);

		if (pkg.exports && typeof pkg.exports === "object") {
			logger.info("\n   Exports:");
			for (const [key, value] of Object.entries(pkg.exports)) {
				if (typeof value === "string") {
					logger.info(`      ${key} → ${value}`);
				} else if (typeof value === "object") {
					logger.info(`      ${key}:`);
					for (const [condKey, condValue] of Object.entries(value)) {
						if (typeof condValue === "string") {
							logger.info(`         ${condKey}: ${condValue}`);
						}
					}
				}
			}
		}

		if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
			const internalDeps = Object.keys(pkg.dependencies).filter((dep) =>
				workspace.packages.some((p) => p.name === dep)
			);
			if (internalDeps.length > 0) {
				logger.info(`\n   Internal dependencies: ${internalDeps.join(", ")}`);
			}
		}

		logger.empty();
	}
}
