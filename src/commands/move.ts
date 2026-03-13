import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import {
	calculateNewSpecifier,
	findPackageForPath,
	isCrossPackageMove,
	normalizePath,
} from "../core/resolver.ts";
import { scanExports, scanModuleReferences } from "../core/scanner.ts";
import { applyTextChanges } from "../core/text-changes.ts";
import {
	addExportToDestinationBarrel,
	findDestinationBarrel,
	updateBarrelExports,
	updateFileReferences,
} from "../core/updater.ts";
import { runTypeCheck } from "../core/verify.ts";
import {
	discoverWorkspace,
	findBuildScript,
	type WorkspaceInfo,
} from "../core/workspace.ts";
import type {
	MoveError,
	MoveResult,
	ProjectConfig,
	UpdatedReference,
} from "../types.ts";

export interface MoveOptions {
	source: string;
	target: string;
	dryRun?: boolean;
	verbose?: boolean;
	verify?: boolean;
	project?: string;
}

export async function moveCommand(options: MoveOptions): Promise<void> {
	const {
		source,
		target,
		dryRun = false,
		verbose = false,
		verify = true,
		project: projectArg,
	} = options;

	const absoluteSource = path.resolve(source);
	const absoluteTarget = path.resolve(target);

	// Find and load project config
	const tsconfigPath = resolveTsConfig(
		projectArg,
		path.dirname(absoluteSource)
	);
	if (!tsconfigPath) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath, absoluteSource);

	// Discover workspace for cross-package move support
	const workspace = await discoverWorkspace(project.rootDir);
	if (verbose && workspace) {
		logger.info(
			`Found workspace: ${workspace.type} with ${workspace.packages.length} packages`
		);
	}

	logger.info(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Moving module...`);
	logger.info(`   From: ${absoluteSource}`);
	logger.info(`   To:   ${absoluteTarget}`);
	if (verify && !dryRun) {
		logger.info("   Verification: enabled");
	}
	logger.empty();

	const result = await moveModule(
		absoluteSource,
		absoluteTarget,
		project,
		dryRun,
		verbose,
		workspace ?? undefined
	);

	// For cross-package moves, run build scripts to update dist/
	if (!dryRun && result.success && workspace) {
		const isCrossPackage = isCrossPackageMove(
			absoluteSource,
			absoluteTarget,
			workspace
		);
		if (isCrossPackage) {
			await runPackageBuilds(
				absoluteSource,
				absoluteTarget,
				workspace,
				verbose
			);
		}
	}

	if (!dryRun && verify && result.success) {
		// Run type checking to verify the move didn't break anything
		const errors = await runTypeCheck(project);
		if (errors.length > 0) {
			logger.error(
				`\n❌ Type checking failed after move - ${errors.length} error(s):`
			);
			for (const error of errors.slice(0, 10)) {
				logger.error(`   ${error}`);
			}
			if (errors.length > 10) {
				logger.error(`   ... and ${errors.length - 10} more`);
			}
			logger.error(
				"\n⚠️  Move completed but introduced type errors. Please review."
			);
			process.exit(1);
		}
		logger.info("\n✅ Type checking passed - no errors introduced");
	}

	printResult(result, dryRun, verbose);

	if (!result.success) {
		process.exit(1);
	}
}

async function runPackageBuilds(
	sourcePath: string,
	targetPath: string,
	workspace: WorkspaceInfo,
	verbose: boolean
): Promise<void> {
	const { spawnSync } = await import("node:child_process");

	// Find source and destination packages
	const sourcePackage = findPackageForPath(sourcePath, workspace);
	const targetPackage = findPackageForPath(targetPath, workspace);

	const packagesToRebuild: Array<{
		name: string;
		path: string;
		script: string;
	}> = [];

	// Destination package needs to be built first (new file needs to be compiled)
	if (targetPackage) {
		const pkg = workspace.packages.find(
			(p) => p.name === targetPackage.packageName
		);
		if (pkg) {
			const buildScript = findBuildScript(pkg);
			if (buildScript) {
				packagesToRebuild.push({
					name: pkg.name,
					path: pkg.path,
					script: buildScript,
				});
			}
		}
	}

	// Source package may need rebuild if barrel files changed
	if (
		sourcePackage &&
		sourcePackage.packageName !== targetPackage?.packageName
	) {
		const pkg = workspace.packages.find(
			(p) => p.name === sourcePackage.packageName
		);
		if (pkg) {
			const buildScript = findBuildScript(pkg);
			if (buildScript) {
				packagesToRebuild.push({
					name: pkg.name,
					path: pkg.path,
					script: buildScript,
				});
			}
		}
	}

	if (packagesToRebuild.length === 0) {
		return;
	}

	logger.info("\n📦 Rebuilding affected packages...");

	for (const pkg of packagesToRebuild) {
		logger.info(`   Building ${pkg.name}...`);

		const result = spawnSync("pnpm", ["run", pkg.script], {
			cwd: pkg.path,
			encoding: "utf-8",
			shell: false,
			stdio: verbose ? "inherit" : "pipe",
		});

		if (result.status === 0) {
			logger.info(`   ✅ ${pkg.name} built successfully`);
		} else {
			logger.error(`   ❌ Build failed for ${pkg.name}`);
			if (!verbose && result.stderr) {
				logger.error(`   ${result.stderr.slice(0, 200)}`);
			}
		}
	}
}

export async function moveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	workspace?: WorkspaceInfo
): Promise<MoveResult> {
	const errors: MoveError[] = [];
	const updatedReferences: UpdatedReference[] = [];

	// Validate source exists
	const sourceFile = Bun.file(sourcePath);
	if (!(await sourceFile.exists())) {
		return {
			success: false,
			movedFile: { from: sourcePath, to: targetPath },
			updatedReferences: [],
			errors: [
				{
					file: sourcePath,
					message: "Source file does not exist",
					recoverable: false,
				},
			],
		};
	}

	// Check target doesn't exist
	const targetFile = Bun.file(targetPath);
	if (await targetFile.exists()) {
		return {
			success: false,
			movedFile: { from: sourcePath, to: targetPath },
			updatedReferences: [],
			errors: [
				{
					file: targetPath,
					message: "Target file already exists",
					recoverable: false,
				},
			],
		};
	}

	// Build dependency graph
	if (verbose) {
		logger.info("Building dependency graph...");
	}
	const graph = buildDependencyGraph(project);

	// Find all files that reference the source file
	const references = findAllReferences(sourcePath, graph);
	if (verbose) {
		logger.info(`Found ${references.length} references to update`);
	}

	// Find barrel files that re-export the source
	const barrelFiles = findBarrelReExports(sourcePath, graph);
	if (verbose && barrelFiles.length > 0) {
		logger.info(`Found ${barrelFiles.length} barrel file(s) to update`);
	}

	// Group references by source file
	const refsByFile = new Map<string, typeof references>();
	for (const ref of references) {
		const existing = refsByFile.get(ref.sourceFile) ?? [];
		existing.push(ref);
		refsByFile.set(ref.sourceFile, existing);
	}

	// Also need to update imports WITHIN the file being moved
	const program = createProgram(project);
	const sourceAst = program.getSourceFile(sourcePath);
	let fileMoved = false;

	// Scan exports from the source file for cross-package move handling
	const movedFileExports = sourceAst ? scanExports(sourceAst) : [];
	if (verbose && movedFileExports.length > 0) {
		logger.info(
			`Moved file exports: ${movedFileExports.map((e) => e.name).join(", ")}`
		);
	}

	if (sourceAst) {
		const internalRefs = scanModuleReferences(sourceAst, project);
		if (internalRefs.length > 0) {
			// Calculate updated internal imports
			const { newContent, updates } = updateInternalImports(
				sourceAst,
				internalRefs,
				sourcePath,
				targetPath,
				project
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				if (!dryRun) {
					// We'll write this as part of the move
					await Bun.write(targetPath, newContent);
					await Bun.file(sourcePath).delete();
					fileMoved = true;
				}
			} else if (!dryRun) {
				// No internal changes, just copy
				const content = await sourceFile.text();
				await Bun.write(targetPath, content);
				await Bun.file(sourcePath).delete();
				fileMoved = true;
			}
		}
	}

	// If file wasn't moved yet (no internal refs or couldn't parse), copy as-is
	if (!(fileMoved || dryRun)) {
		const content = await sourceFile.text();
		await Bun.write(targetPath, content);
		await Bun.file(sourcePath).delete();
	}

	// Update all referencing files
	for (const [filePath, refs] of refsByFile) {
		// Skip the source file itself (we handled it above)
		if (normalizePath(filePath) === normalizePath(sourcePath)) {
			continue;
		}

		try {
			const fileAst = program.getSourceFile(filePath);
			if (!fileAst) {
				errors.push({
					file: filePath,
					message: "Could not parse file",
					recoverable: true,
				});
				continue;
			}

			const { newContent, updates } = updateFileReferences(
				fileAst,
				refs,
				sourcePath,
				targetPath,
				project,
				workspace,
				movedFileExports
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				if (!dryRun) {
					await Bun.write(filePath, newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: filePath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: true,
			});
		}
	}

	// Update barrel files
	for (const barrelPath of barrelFiles) {
		// Skip if already processed as a regular reference
		if (refsByFile.has(barrelPath)) {
			continue;
		}

		try {
			const barrelAst = program.getSourceFile(barrelPath);
			if (!barrelAst) {
				errors.push({
					file: barrelPath,
					message: "Could not parse barrel file",
					recoverable: true,
				});
				continue;
			}

			const { newContent, updates } = updateBarrelExports(
				barrelAst,
				sourcePath,
				targetPath,
				project,
				workspace
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				if (!dryRun) {
					await Bun.write(barrelPath, newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: barrelPath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: true,
			});
		}
	}

	// For cross-package moves, add export to destination barrel
	if (workspace) {
		const destBarrelPath = findDestinationBarrel(targetPath, workspace);
		if (destBarrelPath) {
			try {
				const destBarrelFile = Bun.file(destBarrelPath);
				if (await destBarrelFile.exists()) {
					const barrelContent = await destBarrelFile.text();
					const { newContent, update } = addExportToDestinationBarrel(
						barrelContent,
						targetPath,
						destBarrelPath
					);

					if (newContent !== barrelContent) {
						updatedReferences.push(update);
						if (!dryRun) {
							await Bun.write(destBarrelPath, newContent);
						}
						if (verbose) {
							logger.info(
								`Added export to destination barrel: ${destBarrelPath}`
							);
						}
					}
				}
			} catch (error) {
				errors.push({
					file: destBarrelPath,
					message: `Could not update destination barrel: ${error instanceof Error ? error.message : String(error)}`,
					recoverable: true,
				});
			}
		}
	}

	return {
		success: errors.filter((e) => !e.recoverable).length === 0,
		movedFile: { from: sourcePath, to: targetPath },
		updatedReferences,
		errors,
	};
}

function updateInternalImports(
	sourceFile: ts.SourceFile,
	refs: ReturnType<typeof scanModuleReferences>,
	_oldPath: string,
	newPath: string,
	project: ProjectConfig
): { newContent: string; updates: UpdatedReference[] } {
	const changes: { start: number; end: number; newText: string }[] = [];
	const updates: UpdatedReference[] = [];

	for (const ref of refs) {
		// Calculate what the import should be from the new location
		const newSpecifier = calculateNewSpecifier(
			ref.specifier,
			newPath, // Calculate from new location
			ref.resolvedPath,
			ref.resolvedPath, // Target hasn't moved
			project
		);

		if (newSpecifier !== ref.specifier) {
			const location = findSpecifierInSource(
				sourceFile,
				ref.specifier,
				ref.line
			);
			if (location) {
				changes.push({
					start: location.start,
					end: location.end,
					newText: newSpecifier,
				});

				updates.push({
					file: newPath,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
				});
			}
		}
	}

	// Apply changes using shared utility
	const newContent = applyTextChanges(sourceFile.text, changes);

	return { newContent, updates };
}

function findSpecifierInSource(
	sourceFile: ts.SourceFile,
	specifier: string,
	line: number
): { start: number; end: number } | null {
	let result: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		let moduleSpecifier: ts.StringLiteral | undefined;

		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			moduleSpecifier = node.moduleSpecifier;
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			moduleSpecifier = node.moduleSpecifier;
		} else if (ts.isCallExpression(node)) {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteral(arg)) {
				moduleSpecifier = arg;
			}
		}

		if (moduleSpecifier && moduleSpecifier.text === specifier) {
			const { line: nodeLine } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (nodeLine + 1 === line) {
				result = {
					start: moduleSpecifier.getStart(sourceFile) + 1,
					end: moduleSpecifier.getEnd() - 1,
				};
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

function printResult(
	result: MoveResult,
	dryRun: boolean,
	verbose: boolean
): void {
	if (result.success) {
		logger.info(`✅ ${dryRun ? "Would move" : "Moved"} successfully!\n`);
	} else {
		logger.info(`❌ ${dryRun ? "Would fail" : "Failed"}\n`);
	}

	if (result.updatedReferences.length > 0) {
		logger.info(
			`📝 ${dryRun ? "Would update" : "Updated"} ${result.updatedReferences.length} reference(s):`
		);

		const byFile = new Map<string, UpdatedReference[]>();
		for (const ref of result.updatedReferences) {
			const existing = byFile.get(ref.file) ?? [];
			existing.push(ref);
			byFile.set(ref.file, existing);
		}

		for (const [file, refs] of byFile) {
			const relativePath = path.relative(process.cwd(), file);
			logger.info(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					logger.info(
						`     L${ref.line}: "${ref.oldSpecifier}" → "${ref.newSpecifier}"`
					);
				}
			}
		}
		logger.empty();
	}

	if (result.errors.length > 0) {
		logger.info(`⚠️  Errors (${result.errors.length}):`);
		for (const error of result.errors) {
			const relativePath = path.relative(process.cwd(), error.file);
			const severity = error.recoverable ? "warning" : "error";
			logger.info(`   [${severity}] ${relativePath}: ${error.message}`);
		}
		logger.empty();
	}
}
