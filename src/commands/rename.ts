import path from "node:path";
import ts from "typescript";
import { logger, printCommandResult } from "../cli-logger.ts";
import { buildDependencyGraph, findAllReferences } from "../core/graph.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { getNameNode, hasExportModifier } from "../core/scanner.ts";
import {
	applyTextChanges,
	deduplicateChanges,
	type TextChange,
} from "../core/text-changes.ts";
import { checkAllConflicts } from "../core/verify.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type {
	ModuleReference,
	ProjectConfig,
	UpdatedReference,
} from "../types.ts";

export interface RenameOptions {
	file: string;
	oldName: string;
	newName: string;
	dryRun?: boolean;
	verbose?: boolean;
	project?: string;
	workspace?: boolean;
}

export interface RenameResult {
	success: boolean;
	renamedSymbol: { file: string; oldName: string; newName: string };
	updatedReferences: UpdatedReference[];
	errors: { file: string; message: string }[];
}

export async function renameCommand(options: RenameOptions): Promise<void> {
	const {
		file,
		oldName,
		newName,
		dryRun = false,
		verbose = false,
		project: projectArg,
		workspace = false,
	} = options;

	const absolutePath = path.resolve(file);

	const tsconfigPath = resolveTsConfig(projectArg, path.dirname(absolutePath));
	if (!tsconfigPath) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath, absolutePath);

	// When workspace mode is enabled, collect cross-package projects
	const extraProjects: ProjectConfig[] = [];
	if (workspace) {
		const wsDir = projectArg
			? path.resolve(projectArg)
			: path.dirname(tsconfigPath);
		const wsInfo = await discoverWorkspace(wsDir);
		if (wsInfo && wsInfo.packages.length > 0) {
			const { mapConcurrent } = await import("../core/concurrency.ts");
			const eligiblePkgs = wsInfo.packages.filter(
				(pkg) => pkg.tsconfigPath && pkg.tsconfigPath !== tsconfigPath
			);
			const loaded = await mapConcurrent(
				eligiblePkgs,
				async (pkg) => loadProject(pkg.tsconfigPath as string),
				{ onError: () => null }
			);
			for (const proj of loaded) {
				if (proj) {
					extraProjects.push(proj);
				}
			}
			if (verbose && extraProjects.length > 0) {
				logger.info(
					`Workspace: scanning ${extraProjects.length} additional package(s)`
				);
			}
		}
	}

	logger.info(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Renaming symbol...`);
	logger.info(`   File: ${absolutePath}`);
	logger.info(`   ${oldName} → ${newName}\n`);

	const result = await renameSymbol(
		absolutePath,
		oldName,
		newName,
		project,
		dryRun,
		verbose,
		extraProjects
	);

	printCommandResult(result, "rename", "Renamed", dryRun, verbose);

	if (!result.success) {
		process.exit(1);
	}
}

export async function renameSymbol(
	filePath: string,
	oldName: string,
	newName: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	extraProjects: ProjectConfig[] = []
): Promise<RenameResult> {
	const errors: { file: string; message: string }[] = [];
	const updatedReferences: UpdatedReference[] = [];
	const rt = getRuntime();

	// Validate file exists
	if (!(await rt.fs.exists(filePath))) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			updatedReferences: [],
			errors: [{ file: filePath, message: "File does not exist" }],
		};
	}

	// Build dependency graph
	if (verbose) {
		logger.info("Building dependency graph...");
	}
	const graph = buildDependencyGraph(project);

	// Find all files that import from this file
	const references = findAllReferences(filePath, graph);

	// Also find references from workspace packages
	for (const extraProject of extraProjects) {
		try {
			const extraGraph = buildDependencyGraph(extraProject);
			const extraRefs = findAllReferences(filePath, extraGraph);
			references.push(...extraRefs);
		} catch {
			// Skip packages that fail to build graph
		}
	}
	if (verbose) {
		logger.info(`Found ${references.length} references to check`);
	}

	// Create program for parsing
	const program = createProgram(project);

	// First, rename the export in the source file
	const sourceAst = program.getSourceFile(filePath);
	if (!sourceAst) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			updatedReferences: [],
			errors: [{ file: filePath, message: "Could not parse source file" }],
		};
	}

	// Check if the export exists
	const exportInfo = findExport(sourceAst, oldName);
	if (!exportInfo) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			updatedReferences: [],
			errors: [{ file: filePath, message: `Export "${oldName}" not found` }],
		};
	}

	// Check for all conflicts (export name + binding) in a single call
	const importingFiles: Array<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}> = [];
	for (const ref of references) {
		if (normalizePath(ref.sourceFile) === normalizePath(filePath)) {
			continue;
		}
		if (!ref.bindings) {
			continue;
		}
		const hasUnaliasedImport = ref.bindings.some(
			(b) => b.name === oldName && !b.alias
		);
		if (!hasUnaliasedImport) {
			continue;
		}
		const importingAst = program.getSourceFile(ref.sourceFile);
		if (!importingAst) {
			continue;
		}
		importingFiles.push({
			sourceFile: importingAst,
			specifier: ref.specifier,
			bindings: ref.bindings.map((b) => ({ name: b.name, alias: b.alias })),
		});
	}

	const conflictResult = checkAllConflicts({
		exportNames: [newName],
		targetSourceFile: sourceAst,
		importingFiles,
		skipImportedName: oldName,
	});

	if (conflictResult.hasConflict) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			updatedReferences: [],
			errors: conflictResult.conflicts.map((c) => ({
				file: c.file,
				message: `"${c.name}" already exists${c.line ? ` at line ${c.line}` : ""} — rename would cause a conflict`,
			})),
		};
	}

	// Rename in source file
	const sourceResult = renameInSourceFile(sourceAst, oldName, newName);
	if (sourceResult.changes.length > 0) {
		updatedReferences.push(
			...sourceResult.updates.map((u) => ({ ...u, file: filePath }))
		);
		if (!dryRun) {
			await rt.fs.writeFile(filePath, sourceResult.newContent);
		}
	}

	// Group references by file
	const refsByFile = new Map<string, ModuleReference[]>();
	for (const ref of references) {
		if (normalizePath(ref.sourceFile) === normalizePath(filePath)) {
			continue;
		}
		const existing = refsByFile.get(ref.sourceFile) ?? [];
		existing.push(ref);
		refsByFile.set(ref.sourceFile, existing);
	}

	// Update each importing file
	for (const [importingFile, fileRefs] of refsByFile) {
		try {
			const fileAst = program.getSourceFile(importingFile);
			if (!fileAst) {
				errors.push({ file: importingFile, message: "Could not parse file" });
				continue;
			}

			const result = updateImportReferences(
				fileAst,
				fileRefs,
				oldName,
				newName
			);
			if (result.updates.length > 0) {
				updatedReferences.push(
					...result.updates.map((u) => ({ ...u, file: importingFile }))
				);
				if (!dryRun) {
					await rt.fs.writeFile(importingFile, result.newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: importingFile,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		success: errors.length === 0,
		renamedSymbol: { file: filePath, oldName, newName },
		updatedReferences,
		errors,
	};
}

interface ExportLocation {
	type: "declaration" | "named-export" | "default";
	node: ts.Node;
	line: number;
}

function findExport(
	sourceFile: ts.SourceFile,
	name: string
): ExportLocation | null {
	let result: ExportLocation | null = null;

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		// export class/function/const Name
		if (hasExportModifier(node)) {
			const nameNode = getNameNode(node);
			if (nameNode?.text === name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "declaration", node, line: line + 1 };
				return;
			}
		}

		// export { Name }
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				// Check the exported name (element.name), not the local name (element.propertyName)
				if (element.name.text === name) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile)
					);
					result = { type: "named-export", node: element, line: line + 1 };
					return;
				}
			}
		}

		// export default Name
		if (ts.isExportAssignment(node) && !node.isExportEquals) {
			if (name === "default") {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "default", node, line: line + 1 };
				return;
			}
			// Match by the identifier in the expression (e.g., export default myFunc)
			if (ts.isIdentifier(node.expression) && node.expression.text === name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "default", node, line: line + 1 };
				return;
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

export function renameInSourceFile(
	sourceFile: ts.SourceFile,
	oldName: string,
	newName: string
): {
	newContent: string;
	changes: TextChange[];
	updates: Omit<UpdatedReference, "file">[];
} {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];

	// Returns true if a binding pattern (parameter name, destructuring) introduces `name`
	function bindingContainsName(binding: ts.BindingName): boolean {
		if (ts.isIdentifier(binding)) {
			return binding.text === oldName;
		}
		if (
			ts.isObjectBindingPattern(binding) ||
			ts.isArrayBindingPattern(binding)
		) {
			return binding.elements.some(
				(el) => !ts.isOmittedExpression(el) && bindingContainsName(el.name)
			);
		}
		return false;
	}

	// Returns true if this identifier is declaring a new (inner-scope) binding,
	// rather than referencing the exported symbol.
	function isDeclaringIdentifier(node: ts.Identifier): boolean {
		const { parent } = node;
		if (!parent) {
			return false;
		}
		if (ts.isParameter(parent) && parent.name === node) {
			return true;
		}
		if (ts.isVariableDeclaration(parent) && parent.name === node) {
			return true;
		}
		if (ts.isBindingElement(parent) && parent.name === node) {
			return true;
		}
		if (ts.isFunctionDeclaration(parent) && parent.name === node) {
			return true;
		}
		if (ts.isClassDeclaration(parent) && parent.name === node) {
			return true;
		}
		return false;
	}

	// Returns true if a function-like node introduces a parameter that shadows oldName.
	function nodeIntroducesShadow(node: ts.Node): boolean {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			return (node as ts.FunctionLikeDeclaration).parameters.some((p) =>
				bindingContainsName(p.name)
			);
		}
		return false;
	}

	function visit(node: ts.Node, isShadowed = false) {
		// Inside a scope where oldName is shadowed — skip all renames, recurse only
		if (isShadowed) {
			ts.forEachChild(node, (child) => visit(child, true));
			return;
		}

		// Rename in declaration: export class OldName / export function oldName / export const oldName
		if (hasExportModifier(node)) {
			const nameNode = getNameNode(node);
			if (nameNode && nameNode.text === oldName) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				changes.push({
					start: nameNode.getStart(sourceFile),
					end: nameNode.getEnd(),
					newText: newName,
				});
				updates.push({
					line: line + 1,
					oldSpecifier: oldName,
					newSpecifier: newName,
				});
			}
		}

		// Rename in export { oldName } or export { oldName as alias }
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				// If there's a propertyName, that's the local name, and name is the exported name
				// export { localName as exportedName }
				// If no propertyName, name is both local and exported
				const exportedName = element.name.text;

				if (exportedName === oldName) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						element.getStart(sourceFile)
					);
					changes.push({
						start: element.name.getStart(sourceFile),
						end: element.name.getEnd(),
						newText: newName,
					});
					updates.push({
						line: line + 1,
						oldSpecifier: oldName,
						newSpecifier: newName,
					});
				}
			}
		}

		// Rename identifier in export default <identifier>
		if (
			ts.isExportAssignment(node) &&
			!node.isExportEquals &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === oldName
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			changes.push({
				start: node.expression.getStart(sourceFile),
				end: node.expression.getEnd(),
				newText: newName,
			});
			updates.push({
				line: line + 1,
				oldSpecifier: oldName,
				newSpecifier: newName,
			});
		}

		// Also rename usages within the file itself
		if (ts.isIdentifier(node) && node.text === oldName) {
			// Skip if this is a property access (obj.oldName)
			if (
				node.parent &&
				ts.isPropertyAccessExpression(node.parent) &&
				node.parent.name === node
			) {
				// This is accessing a property, not our symbol
				return;
			}
			// Skip if this is a property in an object literal
			if (
				node.parent &&
				ts.isPropertyAssignment(node.parent) &&
				node.parent.name === node
			) {
				return;
			}
			// Skip import specifiers (handled separately)
			if (
				node.parent &&
				(ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent))
			) {
				return;
			}
			// Skip if this identifier is declaring a new binding in an inner scope
			// (parameter name, variable declaration, destructuring element, inner function/class name)
			if (isDeclaringIdentifier(node)) {
				return;
			}

			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			changes.push({
				start: node.getStart(sourceFile),
				end: node.getEnd(),
				newText: newName,
			});
			updates.push({
				line: line + 1,
				oldSpecifier: oldName,
				newSpecifier: newName,
			});
		}

		// Propagate shadow into function scopes whose parameters introduce a new binding for oldName
		const childIsShadowed = nodeIntroducesShadow(node);
		ts.forEachChild(node, (child) => visit(child, childIsShadowed));
	}

	visit(sourceFile);

	// Deduplicate changes by position
	const uniqueChanges = deduplicateChanges(changes);

	// Apply changes using shared utility
	const newContent = applyTextChanges(sourceFile.text, uniqueChanges);

	return { newContent, changes: uniqueChanges, updates };
}

/**
 * Update import/re-export references for a renamed symbol.
 * Accepts pre-filtered ModuleReference[] scoped to the target file,
 * mirroring the pattern used by updateFileReferences in updater.ts.
 */
function updateImportReferences(
	sourceFile: ts.SourceFile,
	references: ModuleReference[],
	oldName: string,
	newName: string
): { newContent: string; updates: Omit<UpdatedReference, "file">[] } {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];

	// Build a set of (specifier, line) pairs from the pre-filtered references
	const refKeys = new Set(
		references.map((ref) => `${ref.specifier}:${ref.line}`)
	);

	function visit(node: ts.Node) {
		// Handle: import { oldName } from './target'
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (!refKeys.has(`${node.moduleSpecifier.text}:${line + 1}`)) {
				ts.forEachChild(node, visit);
				return;
			}

			const importClause = node.importClause;
			if (
				importClause?.namedBindings &&
				ts.isNamedImports(importClause.namedBindings)
			) {
				for (const element of importClause.namedBindings.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;

					if (importedName === oldName) {
						if (element.propertyName) {
							changes.push({
								start: element.propertyName.getStart(sourceFile),
								end: element.propertyName.getEnd(),
								newText: newName,
							});
						} else {
							changes.push({
								start: element.name.getStart(sourceFile),
								end: element.name.getEnd(),
								newText: newName,
							});
						}

						updates.push({
							line: line + 1,
							oldSpecifier: oldName,
							newSpecifier: newName,
						});
					}
				}
			}
		}

		// Handle namespace re-exports: export * as oldName from './target'
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (!refKeys.has(`${node.moduleSpecifier.text}:${line + 1}`)) {
				ts.forEachChild(node, visit);
				return;
			}

			if (
				node.exportClause &&
				ts.isNamespaceExport(node.exportClause) &&
				node.exportClause.name.text === oldName
			) {
				changes.push({
					start: node.exportClause.name.getStart(sourceFile),
					end: node.exportClause.name.getEnd(),
					newText: newName,
				});
				updates.push({
					line: line + 1,
					oldSpecifier: oldName,
					newSpecifier: newName,
				});
			}

			// Handle named re-exports: export { oldName } from './target'
			if (node.exportClause && ts.isNamedExports(node.exportClause)) {
				for (const element of node.exportClause.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;

					if (importedName === oldName) {
						if (element.propertyName) {
							changes.push({
								start: element.propertyName.getStart(sourceFile),
								end: element.propertyName.getEnd(),
								newText: newName,
							});
						} else {
							changes.push({
								start: element.name.getStart(sourceFile),
								end: element.name.getEnd(),
								newText: newName,
							});
						}

						updates.push({
							line: line + 1,
							oldSpecifier: oldName,
							newSpecifier: newName,
						});
					}
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	const newContent = applyTextChanges(sourceFile.text, changes);
	return { newContent, updates };
}
