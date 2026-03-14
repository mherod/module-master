import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	discoverProject,
	type ProjectDiscovery,
	type TsConfigInfo,
} from "../core/tsconfig-discovery.ts";

export interface DiscoverOptions {
	directory: string;
	verbose?: boolean;
}

export async function discoverCommand(options: DiscoverOptions): Promise<void> {
	const { directory, verbose } = options;
	const absoluteDir = path.resolve(directory);

	logger.info(`\n🔍 Discovering tsconfig files in ${absoluteDir}\n`);

	const discovery = discoverProject(absoluteDir);

	printDiscovery(discovery, absoluteDir, verbose);
}

function printDiscovery(
	discovery: ProjectDiscovery,
	baseDir: string,
	verbose?: boolean
): void {
	const { configs, fileOwnership, rootConfig } = discovery;

	if (configs.length === 0) {
		logger.info("   No tsconfig.json files found.\n");
		return;
	}

	// Summary
	logger.info(`📦 Found ${configs.length} tsconfig file(s)\n`);

	// Root/solution config
	if (rootConfig) {
		const relativePath = path.relative(baseDir, rootConfig.path);
		logger.info(`🏠 Root config: ${relativePath}`);
		if (rootConfig.isSolution) {
			logger.info("   (solution-style with project references)");
		}
		logger.empty();
	}

	// List each config
	for (const config of configs) {
		printConfigInfo(config, baseDir, verbose);
	}

	// File ownership stats
	const totalFiles = fileOwnership.size;
	logger.info(`\n📊 Total files tracked: ${totalFiles}`);

	if (verbose) {
		// Group files by owning config
		const filesByConfig = new Map<string, string[]>();
		for (const [file, config] of fileOwnership) {
			const existing = filesByConfig.get(config.path) ?? [];
			existing.push(file);
			filesByConfig.set(config.path, existing);
		}

		logger.info("\n📁 Files by config:");
		for (const [configPath, files] of filesByConfig) {
			const relativePath = path.relative(baseDir, configPath);
			logger.info(`\n   ${relativePath} (${files.length} files)`);
			if (files.length <= 10) {
				for (const file of files) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
			} else {
				// Show first 5 and last 5
				for (const file of files.slice(0, 5)) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
				logger.info(`      ... ${files.length - 10} more ...`);
				for (const file of files.slice(-5)) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
			}
		}
	}

	logger.empty();
}

function printConfigInfo(
	config: TsConfigInfo,
	baseDir: string,
	verbose?: boolean
): void {
	const relativePath = path.relative(baseDir, config.path);

	logger.info(`📄 ${relativePath}`);
	logger.info(`   Root: ${path.relative(baseDir, config.rootDir) || "."}`);

	if (config.isSolution) {
		logger.info("   Type: Solution (project references only)");
	} else {
		logger.info(`   Files: ${config.files.length}`);
	}

	if (config.extends) {
		const extendsRel = path.relative(baseDir, config.extends);
		logger.info(`   Extends: ${extendsRel}`);
	}

	if (config.references.length > 0) {
		logger.info(`   References: ${config.references.length}`);
		if (verbose) {
			for (const ref of config.references) {
				const refRel = path.relative(baseDir, ref.path);
				logger.info(`      → ${refRel}`);
			}
		}
	}

	if (verbose) {
		if (config.include.length > 0) {
			logger.info(`   Include: ${config.include.join(", ")}`);
		}
		if (config.exclude.length > 0) {
			logger.info(`   Exclude: ${config.exclude.join(", ")}`);
		}

		// Path aliases
		if (config.pathAliases.size > 0) {
			logger.info("   Path aliases:");
			for (const [alias, paths] of config.pathAliases) {
				logger.info(`      ${alias} → ${paths.join(", ")}`);
			}
		}
	}

	logger.empty();
}
