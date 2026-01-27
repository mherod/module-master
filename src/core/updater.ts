import ts from "typescript";
import type {
	ModuleReference,
	ProjectConfig,
	UpdatedReference,
} from "../types.ts";
import { calculateNewSpecifier } from "./resolver.ts";

interface TextChange {
	start: number;
	end: number;
	newText: string;
}

/**
 * Update import specifiers in a file after a module has moved
 */
export function updateFileReferences(
	sourceFile: ts.SourceFile,
	references: ModuleReference[],
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const updates: UpdatedReference[] = [];

	for (const ref of references) {
		const newSpecifier = calculateNewSpecifier(
			ref.specifier,
			ref.sourceFile,
			oldPath,
			newPath,
			project,
		);

		if (newSpecifier !== ref.specifier) {
			const change = findSpecifierLocation(sourceFile, ref);
			if (change) {
				changes.push({
					start: change.start,
					end: change.end,
					newText: newSpecifier,
				});

				updates.push({
					file: ref.sourceFile,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
				});
			}
		}
	}

	// Apply changes in reverse order to maintain positions
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

/**
 * Find the exact location of a module specifier in the source
 */
function findSpecifierLocation(
	sourceFile: ts.SourceFile,
	ref: ModuleReference,
): { start: number; end: number } | null {
	let result: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (result) return;

		// Check import declarations
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			if (node.moduleSpecifier.text === ref.specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				if (line + 1 === ref.line) {
					// +1 to skip opening quote, -1 to skip closing quote
					result = {
						start: node.moduleSpecifier.getStart(sourceFile) + 1,
						end: node.moduleSpecifier.getEnd() - 1,
					};
				}
			}
		}

		// Check export declarations
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			if (node.moduleSpecifier.text === ref.specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				if (line + 1 === ref.line) {
					result = {
						start: node.moduleSpecifier.getStart(sourceFile) + 1,
						end: node.moduleSpecifier.getEnd() - 1,
					};
				}
			}
		}

		// Check dynamic imports and require calls
		if (ts.isCallExpression(node)) {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteral(arg) && arg.text === ref.specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				if (line + 1 === ref.line) {
					result = {
						start: arg.getStart(sourceFile) + 1,
						end: arg.getEnd() - 1,
					};
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

/**
 * Update barrel file re-exports after a module has moved
 */
export function updateBarrelExports(
	sourceFile: ts.SourceFile,
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const updates: UpdatedReference[] = [];

	function visit(node: ts.Node) {
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;
			const newSpecifier = calculateNewSpecifier(
				specifier,
				sourceFile.fileName,
				oldPath,
				newPath,
				project,
			);

			if (newSpecifier !== specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				changes.push({
					start: node.moduleSpecifier.getStart(sourceFile) + 1,
					end: node.moduleSpecifier.getEnd() - 1,
					newText: newSpecifier,
				});

				updates.push({
					file: sourceFile.fileName,
					line: line + 1,
					oldSpecifier: specifier,
					newSpecifier,
				});
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
