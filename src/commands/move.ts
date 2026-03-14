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
	findSpecifierLocation,
	updateBarrelExports,
	updateFileReferences,
} from "../core/updater.ts";
import { checkAllConflicts, runTypeCheck } from "../core/verify.ts";
import {
	discoverWorkspace,
	findBuildScript,
	type WorkspaceInfo,
} from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
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
		const errors = runTypeCheck(project);
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
	const rt = getRuntime();

	// Validate source exists
	if (!(await rt.fs.exists(sourcePath))) {
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
	if (await rt.fs.exists(targetPath)) {
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

	// Determine if this is a cross-package move early (needed for ref collection strategy)
	const crossPackage = workspace
		? isCrossPackageMove(sourcePath, targetPath, workspace)
		: false;

	// Find all files that reference the source file.
	// For cross-package moves: include indirect barrel consumers because the source
	// barrel's re-export is removed, so consumers need their package imports updated.
	// For same-package moves: use only direct references so barrel consumers are NOT
	// rewritten — the barrel's updated re-export keeps consumers working unchanged.
	const references = crossPackage
		? findAllReferences(sourcePath, graph)
		: (graph.importedBy.get(normalizePath(sourcePath)) ?? []);
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

	// Check for all conflicts (export name + binding) in a single call
	if (movedFileExports.length > 0) {
		let targetBarrelAst: ts.SourceFile | undefined;
		if (workspace) {
			const destBarrelPath = findDestinationBarrel(targetPath, workspace);
			if (destBarrelPath && (await rt.fs.exists(destBarrelPath))) {
				const barrelContent = await rt.fs.readFile(destBarrelPath);
				targetBarrelAst = ts.createSourceFile(
					destBarrelPath,
					barrelContent,
					ts.ScriptTarget.Latest,
					true
				);
			}
		}

		const importingFiles: Array<{
			sourceFile: ts.SourceFile;
			specifier: string;
			bindings: Array<{ name: string; alias?: string }>;
		}> = [];
		for (const ref of references) {
			if (normalizePath(ref.sourceFile) === normalizePath(sourcePath)) {
				continue;
			}
			if (!ref.bindings) {
				continue;
			}
			const importingAst = program.getSourceFile(ref.sourceFile);
			if (!importingAst) {
				continue;
			}
			importingFiles.push({
				sourceFile: importingAst,
				specifier: ref.specifier,
				bindings: ref.bindings.map((b) => ({
					name: b.name,
					alias: b.alias,
				})),
			});
		}

		const conflictResult = checkAllConflicts({
			exportNames: movedFileExports.map((e) => e.name),
			targetSourceFile: targetBarrelAst,
			importingFiles,
		});

		if (conflictResult.hasConflict) {
			return {
				success: false,
				movedFile: { from: sourcePath, to: targetPath },
				updatedReferences: [],
				errors: conflictResult.conflicts.map((c) => ({
					file: c.file,
					message: `Conflict: "${c.name}" already exists${c.line ? ` at line ${c.line}` : ""}`,
					recoverable: false,
				})),
			};
		}
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
					await rt.fs.writeFile(targetPath, newContent);
					await rt.fs.deleteFile(sourcePath);
					fileMoved = true;
				}
			} else if (!dryRun) {
				// No internal changes, just copy
				const content = await rt.fs.readFile(sourcePath);
				await rt.fs.writeFile(targetPath, content);
				await rt.fs.deleteFile(sourcePath);
				fileMoved = true;
			}
		}
	}

	// If file wasn't moved yet (no internal refs or couldn't parse), copy as-is
	if (!(fileMoved || dryRun)) {
		const content = await rt.fs.readFile(sourcePath);
		await rt.fs.writeFile(targetPath, content);
		await rt.fs.deleteFile(sourcePath);
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
					await rt.fs.writeFile(filePath, newContent);
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
					await rt.fs.writeFile(barrelPath, newContent);
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
				if (await rt.fs.exists(destBarrelPath)) {
					const barrelContent = await rt.fs.readFile(destBarrelPath);
					const { newContent, update } = addExportToDestinationBarrel(
						barrelContent,
						targetPath,
						destBarrelPath
					);

					if (newContent !== barrelContent) {
						updatedReferences.push(update);
						if (!dryRun) {
							await rt.fs.writeFile(destBarrelPath, newContent);
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
			const location = findSpecifierLocation(sourceFile, ref);
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
