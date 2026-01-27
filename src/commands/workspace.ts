import path from "node:path";
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

export async function workspaceCommand(options: WorkspaceOptions): Promise<void> {
	const { directory, verbose = false, json = false } = options;
	const absoluteDir = path.resolve(directory);

	const workspace = await discoverWorkspace(absoluteDir);

	if (!workspace) {
		console.error("❌ No workspace found. Looking for:");
		console.error("   - pnpm-workspace.yaml");
		console.error("   - package.json with 'workspaces' field");
		process.exit(1);
	}

	if (json) {
		console.log(JSON.stringify(workspace, null, 2));
		return;
	}

	printWorkspaceInfo(workspace);

	if (verbose) {
		printDetailedPackageInfo(workspace);
	}
}

function printDetailedPackageInfo(workspace: WorkspaceInfo): void {
	console.log("\n📋 Package Details:\n");

	for (const pkg of workspace.packages) {
		console.log(`━━━ ${pkg.name} ━━━`);

		if (pkg.exports && typeof pkg.exports === "object") {
			console.log("\n   Exports:");
			for (const [key, value] of Object.entries(pkg.exports)) {
				if (typeof value === "string") {
					console.log(`      ${key} → ${value}`);
				} else if (typeof value === "object") {
					console.log(`      ${key}:`);
					for (const [condKey, condValue] of Object.entries(value)) {
						if (typeof condValue === "string") {
							console.log(`         ${condKey}: ${condValue}`);
						}
					}
				}
			}
		}

		if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
			const internalDeps = Object.keys(pkg.dependencies).filter((dep) =>
				workspace.packages.some((p) => p.name === dep),
			);
			if (internalDeps.length > 0) {
				console.log(`\n   Internal dependencies: ${internalDeps.join(", ")}`);
			}
		}

		console.log();
	}
}
