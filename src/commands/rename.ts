import path from "node:path";
import ts from "typescript";
import { buildDependencyGraph, findAllReferences } from "../core/graph.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
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
	} = options;

	const absolutePath = path.resolve(file);

	const tsconfigPath = resolveTsConfig(
		projectArg,
		path.dirname(absolutePath),
	);
	if (!tsconfigPath) {
		console.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath);

	console.log(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Renaming symbol...`);
	console.log(`   File: ${absolutePath}`);
	console.log(`   ${oldName} → ${newName}\n`);

	const result = await renameSymbol(
		absolutePath,
		oldName,
		newName,
		project,
		dryRun,
		verbose,
	);

	printResult(result, dryRun, verbose);

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
): Promise<RenameResult> {
	const errors: { file: string; message: string }[] = [];
	const updatedReferences: UpdatedReference[] = [];

	// Validate file exists
	const sourceFile = Bun.file(filePath);
	if (!(await sourceFile.exists())) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			updatedReferences: [],
			errors: [{ file: filePath, message: "File does not exist" }],
		};
	}

	// Build dependency graph
	if (verbose) console.log("Building dependency graph...");
	const graph = buildDependencyGraph(project);

	// Find all files that import from this file
	const references = findAllReferences(filePath, graph);
	if (verbose) console.log(`Found ${references.length} references to check`);

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

	// Rename in source file
	const sourceResult = renameInSourceFile(sourceAst, oldName, newName);
	if (sourceResult.changes.length > 0) {
		updatedReferences.push(
			...sourceResult.updates.map((u) => ({ ...u, file: filePath })),
		);
		if (!dryRun) {
			await Bun.write(filePath, sourceResult.newContent);
		}
	}

	// Group references by file
	const refsByFile = new Map<string, ModuleReference[]>();
	for (const ref of references) {
		if (normalizePath(ref.sourceFile) === normalizePath(filePath)) continue;
		const existing = refsByFile.get(ref.sourceFile) ?? [];
		existing.push(ref);
		refsByFile.set(ref.sourceFile, existing);
	}

	// Update each importing file
	for (const [importingFile] of refsByFile) {
		try {
			const fileAst = program.getSourceFile(importingFile);
			if (!fileAst) {
				errors.push({ file: importingFile, message: "Could not parse file" });
				continue;
			}

			const result = updateImportReferences(
				fileAst,
				filePath,
				oldName,
				newName,
				project,
			);
			if (result.updates.length > 0) {
				updatedReferences.push(
					...result.updates.map((u) => ({ ...u, file: importingFile })),
				);
				if (!dryRun) {
					await Bun.write(importingFile, result.newContent);
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
	name: string,
): ExportLocation | null {
	let result: ExportLocation | null = null;

	function visit(node: ts.Node) {
		if (result) return;

		// export class/function/const Name
		if (hasExportModifier(node)) {
			const declName = getDeclarationName(node);
			if (declName === name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				result = { type: "declaration", node, line: line + 1 };
				return;
			}
		}

		// export { Name }
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause
		) {
			if (ts.isNamedExports(node.exportClause)) {
				for (const element of node.exportClause.elements) {
					// Check the exported name (element.name), not the local name (element.propertyName)
					if (element.name.text === name) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(
							node.getStart(sourceFile),
						);
						result = { type: "named-export", node: element, line: line + 1 };
						return;
					}
				}
			}
		}

		// export default Name (when name is "default")
		if (
			ts.isExportAssignment(node) &&
			!node.isExportEquals &&
			name === "default"
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile),
			);
			result = { type: "default", node, line: line + 1 };
			return;
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

function getDeclarationName(node: ts.Node): string | null {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isClassDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isVariableStatement(node)) {
		const decl = node.declarationList.declarations[0];
		if (decl && ts.isIdentifier(decl.name)) {
			return decl.name.text;
		}
	}
	if (ts.isTypeAliasDeclaration(node)) {
		return node.name.text;
	}
	if (ts.isInterfaceDeclaration(node)) {
		return node.name.text;
	}
	if (ts.isEnumDeclaration(node)) {
		return node.name.text;
	}
	return null;
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts
			.getModifiers(node)
			?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}

interface TextChange {
	start: number;
	end: number;
	newText: string;
}

function renameInSourceFile(
	sourceFile: ts.SourceFile,
	oldName: string,
	newName: string,
): {
	newContent: string;
	changes: TextChange[];
	updates: Omit<UpdatedReference, "file">[];
} {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];

	function visit(node: ts.Node) {
		// Rename in declaration: export class OldName / export function oldName / export const oldName
		if (hasExportModifier(node)) {
			const nameNode = getNameNode(node);
			if (nameNode && nameNode.text === oldName) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
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
			node.exportClause
		) {
			if (ts.isNamedExports(node.exportClause)) {
				for (const element of node.exportClause.elements) {
					// If there's a propertyName, that's the local name, and name is the exported name
					// export { localName as exportedName }
					// If no propertyName, name is both local and exported
					const exportedName = element.name.text;

					if (exportedName === oldName) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(
							element.getStart(sourceFile),
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

			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile),
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

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	// Deduplicate changes by position
	const uniqueChanges = deduplicateChanges(changes);

	// Apply changes in reverse order
	uniqueChanges.sort((a, b) => b.start - a.start);

	let newContent = sourceFile.text;
	for (const change of uniqueChanges) {
		newContent =
			newContent.slice(0, change.start) +
			change.newText +
			newContent.slice(change.end);
	}

	return { newContent, changes: uniqueChanges, updates };
}

function getNameNode(node: ts.Node): ts.Identifier | null {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name;
	}
	if (ts.isClassDeclaration(node) && node.name) {
		return node.name;
	}
	if (ts.isVariableStatement(node)) {
		const decl = node.declarationList.declarations[0];
		if (decl && ts.isIdentifier(decl.name)) {
			return decl.name;
		}
	}
	if (ts.isTypeAliasDeclaration(node)) {
		return node.name;
	}
	if (ts.isInterfaceDeclaration(node)) {
		return node.name;
	}
	if (ts.isEnumDeclaration(node)) {
		return node.name;
	}
	return null;
}

function deduplicateChanges(changes: TextChange[]): TextChange[] {
	const seen = new Set<string>();
	return changes.filter((change) => {
		const key = `${change.start}-${change.end}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function updateImportReferences(
	sourceFile: ts.SourceFile,
	_targetFilePath: string,
	oldName: string,
	newName: string,
	_project: ProjectConfig,
): { newContent: string; updates: Omit<UpdatedReference, "file">[] } {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];

	function visit(node: ts.Node) {
		// Handle: import { oldName } from './target'
		// Handle: import { oldName as alias } from './target'
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const importClause = node.importClause;
			if (
				importClause?.namedBindings &&
				ts.isNamedImports(importClause.namedBindings)
			) {
				for (const element of importClause.namedBindings.elements) {
					// element.propertyName is the imported name, element.name is the local binding
					// import { importedName as localName }
					// If no propertyName, then name is both
					const importedName = element.propertyName?.text ?? element.name.text;

					if (importedName === oldName) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(
							element.getStart(sourceFile),
						);

						if (element.propertyName) {
							// import { oldName as alias } → import { newName as alias }
							changes.push({
								start: element.propertyName.getStart(sourceFile),
								end: element.propertyName.getEnd(),
								newText: newName,
							});
						} else {
							// import { oldName } → import { newName }
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

		// Handle re-exports: export { oldName } from './target'
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				// element.propertyName is the imported name, element.name is the re-exported name
				const importedName = element.propertyName?.text ?? element.name.text;

				if (importedName === oldName) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						element.getStart(sourceFile),
					);

					if (element.propertyName) {
						// export { oldName as alias } from → export { newName as alias } from
						changes.push({
							start: element.propertyName.getStart(sourceFile),
							end: element.propertyName.getEnd(),
							newText: newName,
						});
					} else {
						// export { oldName } from → export { newName } from
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

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

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

function printResult(
	result: RenameResult,
	dryRun: boolean,
	verbose: boolean,
): void {
	if (result.success) {
		console.log(`✅ ${dryRun ? "Would rename" : "Renamed"} successfully!\n`);
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
			console.log(`   ${relativePath}: ${error.message}`);
		}
		console.log();
	}
}
