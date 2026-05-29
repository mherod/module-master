import path from "node:path";
import { logger, printCommandResult } from "../cli-logger.ts";
import type ts from "../core/ast-utils.ts";
import { checkAllConflicts } from "../core/conflict-detection.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import {
	isSameDirectoryCaseOnlyRename,
	safeCaseRename,
	shouldUseSafeCaseRename,
} from "../core/filesystem-case.ts";
import { ensureCleanWorktree } from "../core/git.ts";
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
import { createSourceFileFromText } from "../core/source-file.ts";
import { applyTextChanges } from "../core/text-changes.ts";
import {
	addExportToDestinationBarrel,
	findDestinationBarrel,
	findSpecifierLocation,
	updateBarrelExports,
	updateFileReferences,
} from "../core/updater.ts";
import { isIncompleteTypeCheck, runTypeCheck } from "../core/verify.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
	findBuildScript,
	type WorkspaceInfo,
} from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { Runtime } from "../runtime/types.ts";
import type { MoveError, MoveResult, UpdatedReference } from "../types/move.ts";
import type { MutatingCommandOptions, ProjectConfig } from "../types.ts";

export interface MoveOptions extends MutatingCommandOptions {
	source: string;
	target: string;
	verify?: boolean;
}

export async function moveCommand(options: MoveOptions): Promise<void> {
	const {
		source,
		target,
		dryRun = false,
		force = false,
		verbose = false,
		verify = true,
		project: projectArg,
	} = options;

	const absoluteSource = path.resolve(source);
	const absoluteTarget = path.resolve(target);

	// Guard: refuse to mutate a dirty worktree unless --force
	await ensureCleanWorktree(path.dirname(absoluteSource), force, dryRun);

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

	// Enforce workspace boundary: reject moves outside the workspace root
	if (workspace) {
		const [sourceInBounds] = filterToWorkspaceBoundary(
			[absoluteSource],
			workspace.root
		);
		const [targetInBounds] = filterToWorkspaceBoundary(
			[absoluteTarget],
			workspace.root
		);
		if (!sourceInBounds) {
			logger.error(`Source file is outside workspace root: ${workspace.root}`);
			process.exit(1);
		}
		if (!targetInBounds) {
			logger.error(`Target path is outside workspace root: ${workspace.root}`);
			process.exit(1);
		}
	}

	logger.info(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Moving module...`);
	logger.info(`   From: ${absoluteSource}`);
	logger.info(`   To:   ${absoluteTarget}`);
	if (await shouldUseSafeCaseRename(absoluteSource, absoluteTarget)) {
		logger.info("   Case-only rename: via two-step git mv");
	}
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
		workspace ?? undefined,
		force
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
			const incomplete = isIncompleteTypeCheck(errors);
			logger.error(
				incomplete
					? `\n❌ Type checking did not complete after move (${errors.length} fatal/global diagnostic(s)) — the move may have introduced errors that could not be detected:`
					: `\n❌ Type checking failed after move - ${errors.length} error(s):`
			);
			for (const error of errors.slice(0, 10)) {
				logger.error(`   ${error}`);
			}
			if (errors.length > 10) {
				logger.error(`   ... and ${errors.length - 10} more`);
			}
			logger.error(
				incomplete
					? "\n⚠️  Move completed but verification was incomplete. Please review the moved file and any dependencies manually."
					: "\n⚠️  Move completed but introduced type errors. Please review."
			);
			process.exit(1);
		}
		logger.info("\n✅ Type checking passed - no errors introduced");
	}

	printCommandResult(result, "move", "Moved", dryRun, verbose, project.rootDir);

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

	const { mapConcurrent } = await import("../core/concurrency.ts");
	await mapConcurrent(
		packagesToRebuild,
		async (pkg) => {
			logger.info(`   Building ${pkg.name}...`);
			const proc = Bun.spawn(["pnpm", "run", pkg.script], {
				cwd: pkg.path,
				stdout: verbose ? "inherit" : "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(proc.stderr).text();
			await proc.exited;
			if (proc.exitCode === 0) {
				logger.info(`   ✅ ${pkg.name} built successfully`);
			} else {
				logger.error(`   ❌ Build failed for ${pkg.name}`);
				if (!verbose && stderr) {
					logger.error(`   ${stderr.slice(0, 200)}`);
				}
			}
		},
		{ onError: () => undefined }
	);
}

export async function moveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	workspace?: WorkspaceInfo,
	force = false
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

	// Check target doesn't exist. On case-insensitive filesystems, the target
	// path for a same-directory case-only rename aliases the source path.
	const targetAliasesSource =
		isSameDirectoryCaseOnlyRename(sourcePath, targetPath) &&
		(await shouldUseSafeCaseRename(sourcePath, targetPath));
	if ((await rt.fs.exists(targetPath)) && !targetAliasesSource) {
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
	const graph = await buildDependencyGraph(project);

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

	// Also need to update imports WITHIN the file being moved.
	// Reuse the graph's program when available — buildDependencyGraph always
	// sets it for project-loaded graphs, so the fallback only fires for
	// test-constructed graphs that bypass buildDependencyGraph.
	const program = graph.program ?? createProgram(project);
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
				targetBarrelAst = createSourceFileFromText(
					destBarrelPath,
					barrelContent
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
			// Enrich each conflict with a duplicate-similarity verdict. When the
			// destination already declares an export with the same name, compare the
			// two bodies so the user learns whether the existing declaration is
			// essentially a duplicate of the one being moved (issue: transparent
			// duplicate detection). The conflict still blocks unless --force.
			const conflicts = conflictResult.conflicts.map((c) => {
				let detail = "";
				if (
					sourceAst &&
					targetBarrelAst &&
					normalizePath(c.file) === normalizePath(targetBarrelAst.fileName)
				) {
					detail = describeComparison(
						compareDeclarations(sourceAst, c.name, targetBarrelAst, c.name)
					);
				}
				const location = c.line ? ` at ${c.line}:${c.column}` : "";
				return {
					file: c.file,
					message: `Conflict: "${c.name}" already exists${location}${detail}`,
					recoverable: false,
				};
			});

			if (force) {
				for (const c of conflicts) {
					logger.warn(`⚠️  Proceeding past conflict (--force): ${c.message}`);
				}
			} else {
				return {
					success: false,
					movedFile: { from: sourcePath, to: targetPath },
					updatedReferences: [],
					errors: conflicts.map((c) => ({
						...c,
						message: `${c.message}. Re-run with --force to proceed.`,
					})),
				};
			}
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
					await moveFileWithContent(rt, sourcePath, targetPath, newContent);
					fileMoved = true;
				}
			} else if (!dryRun) {
				// No internal changes, just copy
				const content = await rt.fs.readFile(sourcePath);
				await moveFileWithContent(rt, sourcePath, targetPath, content);
				fileMoved = true;
			}
		}
	}

	// If file wasn't moved yet (no internal refs or couldn't parse), copy as-is
	if (!(fileMoved || dryRun)) {
		const content = await rt.fs.readFile(sourcePath);
		await moveFileWithContent(rt, sourcePath, targetPath, content);
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
	if (workspace && crossPackage) {
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

async function moveFileWithContent(
	rt: Runtime,
	sourcePath: string,
	targetPath: string,
	content: string
): Promise<void> {
	if (await shouldUseSafeCaseRename(sourcePath, targetPath)) {
		await safeCaseRename(rt, sourcePath, targetPath);
		await rt.fs.writeFile(targetPath, content);
		return;
	}

	await rt.fs.writeFile(targetPath, content);
	await rt.fs.deleteFile(sourcePath);
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
