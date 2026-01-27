import path from "node:path";
import ts from "typescript";
import {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import { createProgram, findTsConfig, loadProject } from "../core/project.ts";
import { calculateNewSpecifier, normalizePath } from "../core/resolver.ts";
import { scanModuleReferences } from "../core/scanner.ts";
import { updateBarrelExports, updateFileReferences } from "../core/updater.ts";
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
}

export async function moveCommand(options: MoveOptions): Promise<void> {
	const { source, target, dryRun = false, verbose = false } = options;

	const absoluteSource = path.resolve(source);
	const absoluteTarget = path.resolve(target);

	// Find and load project config
	const tsconfigPath = findTsConfig(path.dirname(absoluteSource));
	if (!tsconfigPath) {
		console.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath);

	console.log(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Moving module...`);
	console.log(`   From: ${absoluteSource}`);
	console.log(`   To:   ${absoluteTarget}\n`);

	const result = await moveModule(
		absoluteSource,
		absoluteTarget,
		project,
		dryRun,
		verbose,
	);

	printResult(result, dryRun, verbose);

	if (!result.success) {
		process.exit(1);
	}
}

export async function moveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
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
	if (verbose) console.log("Building dependency graph...");
	const graph = buildDependencyGraph(project);

	// Find all files that reference the source file
	const references = findAllReferences(sourcePath, graph, project);
	if (verbose) console.log(`Found ${references.length} references to update`);

	// Find barrel files that re-export the source
	const barrelFiles = findBarrelReExports(sourcePath, graph);
	if (verbose && barrelFiles.length > 0) {
		console.log(`Found ${barrelFiles.length} barrel file(s) to update`);
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
	if (sourceAst) {
		const internalRefs = scanModuleReferences(sourceAst, project);
		if (internalRefs.length > 0) {
			// Calculate updated internal imports
			const { newContent, updates } = updateInternalImports(
				sourceAst,
				internalRefs,
				sourcePath,
				targetPath,
				project,
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				if (!dryRun) {
					// We'll write this as part of the move
					await Bun.write(targetPath, newContent);
					await Bun.file(sourcePath).delete();
				}
			} else if (!dryRun) {
				// No internal changes, just copy
				const content = await sourceFile.text();
				await Bun.write(targetPath, content);
				await Bun.file(sourcePath).delete();
			}
		}
	} else if (!dryRun) {
		// Couldn't parse, just copy as-is
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
		if (refsByFile.has(barrelPath)) continue;

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
	project: ProjectConfig,
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
			project,
		);

		if (newSpecifier !== ref.specifier) {
			const location = findSpecifierInSource(
				sourceFile,
				ref.specifier,
				ref.line,
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

	// Apply changes in reverse order
	changes.sort((a, b) => b.start - a.start);

	let newContent = sourceFile.text;
	for (const change of changes) {
		newContent =
			newContent.slice(0, change.start) +
			change.newText +
			newContent.slice(change.end);
	}

	return { newContent, updates };
}

function findSpecifierInSource(
	sourceFile: ts.SourceFile,
	specifier: string,
	line: number,
): { start: number; end: number } | null {
	let result: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (result) return;

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
				node.getStart(),
			);
			if (nodeLine + 1 === line) {
				result = {
					start: moduleSpecifier.getStart() + 1,
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
	verbose: boolean,
): void {
	if (result.success) {
		console.log(`✅ ${dryRun ? "Would move" : "Moved"} successfully!\n`);
	} else {
		console.log(`❌ ${dryRun ? "Would fail" : "Failed"}\n`);
	}

	if (result.updatedReferences.length > 0) {
		console.log(
			`📝 ${dryRun ? "Would update" : "Updated"} ${result.updatedReferences.length} reference(s):`,
		);

		const byFile = new Map<string, UpdatedReference[]>();
		for (const ref of result.updatedReferences) {
			const existing = byFile.get(ref.file) ?? [];
			existing.push(ref);
			byFile.set(ref.file, existing);
		}

		for (const [file, refs] of byFile) {
			const relativePath = path.relative(process.cwd(), file);
			console.log(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					console.log(
						`     L${ref.line}: "${ref.oldSpecifier}" → "${ref.newSpecifier}"`,
					);
				}
			}
		}
		console.log();
	}

	if (result.errors.length > 0) {
		console.log(`⚠️  Errors (${result.errors.length}):`);
		for (const error of result.errors) {
			const relativePath = path.relative(process.cwd(), error.file);
			const severity = error.recoverable ? "warning" : "error";
			console.log(`   [${severity}] ${relativePath}: ${error.message}`);
		}
		console.log();
	}
}
