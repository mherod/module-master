import path from "node:path";
import {
	type ProjectDiscovery,
	type TsConfigInfo,
	discoverProject,
} from "../core/tsconfig-discovery.ts";

export interface DiscoverOptions {
	directory: string;
	verbose?: boolean;
}

export async function discoverCommand(options: DiscoverOptions): Promise<void> {
	const { directory, verbose } = options;
	const absoluteDir = path.resolve(directory);

	console.log(`\n🔍 Discovering tsconfig files in ${absoluteDir}\n`);

	const discovery = discoverProject(absoluteDir);

	printDiscovery(discovery, absoluteDir, verbose);
}

function printDiscovery(
	discovery: ProjectDiscovery,
	baseDir: string,
	verbose?: boolean,
): void {
	const { configs, fileOwnership, rootConfig } = discovery;

	if (configs.length === 0) {
		console.log("   No tsconfig.json files found.\n");
		return;
	}

	// Summary
	console.log(`📦 Found ${configs.length} tsconfig file(s)\n`);

	// Root/solution config
	if (rootConfig) {
		const relativePath = path.relative(baseDir, rootConfig.path);
		console.log(`🏠 Root config: ${relativePath}`);
		if (rootConfig.isSolution) {
			console.log("   (solution-style with project references)");
		}
		console.log();
	}

	// List each config
	for (const config of configs) {
		printConfigInfo(config, baseDir, verbose);
	}

	// File ownership stats
	const totalFiles = fileOwnership.size;
	console.log(`\n📊 Total files tracked: ${totalFiles}`);

	if (verbose) {
		// Group files by owning config
		const filesByConfig = new Map<string, string[]>();
		for (const [file, config] of fileOwnership) {
			const existing = filesByConfig.get(config.path) ?? [];
			existing.push(file);
			filesByConfig.set(config.path, existing);
		}

		console.log("\n📁 Files by config:");
		for (const [configPath, files] of filesByConfig) {
			const relativePath = path.relative(baseDir, configPath);
			console.log(`\n   ${relativePath} (${files.length} files)`);
			if (files.length <= 10) {
				for (const file of files) {
					console.log(`      ${path.relative(baseDir, file)}`);
				}
			} else {
				// Show first 5 and last 5
				for (const file of files.slice(0, 5)) {
					console.log(`      ${path.relative(baseDir, file)}`);
				}
				console.log(`      ... ${files.length - 10} more ...`);
				for (const file of files.slice(-5)) {
					console.log(`      ${path.relative(baseDir, file)}`);
				}
			}
		}
	}

	console.log();
}

function printConfigInfo(
	config: TsConfigInfo,
	baseDir: string,
	verbose?: boolean,
): void {
	const relativePath = path.relative(baseDir, config.path);

	console.log(`📄 ${relativePath}`);
	console.log(`   Root: ${path.relative(baseDir, config.rootDir) || "."}`);

	if (config.isSolution) {
		console.log("   Type: Solution (project references only)");
	} else {
		console.log(`   Files: ${config.files.length}`);
	}

	if (config.extends) {
		const extendsRel = path.relative(baseDir, config.extends);
		console.log(`   Extends: ${extendsRel}`);
	}

	if (config.references.length > 0) {
		console.log(`   References: ${config.references.length}`);
		if (verbose) {
			for (const ref of config.references) {
				const refRel = path.relative(baseDir, ref.path);
				console.log(`      → ${refRel}`);
			}
		}
	}

	if (verbose) {
		if (config.include.length > 0) {
			console.log(`   Include: ${config.include.join(", ")}`);
		}
		if (config.exclude.length > 0) {
			console.log(`   Exclude: ${config.exclude.join(", ")}`);
		}

		// Path aliases
		if (config.pathAliases.size > 0) {
			console.log("   Path aliases:");
			for (const [alias, paths] of config.pathAliases) {
				console.log(`      ${alias} → ${paths.join(", ")}`);
			}
		}
	}

	console.log();
}
