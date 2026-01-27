import ts from "typescript";
import type {
	ModuleReference,
	ProjectConfig,
	UpdatedReference,
} from "../types.ts";
import path from "node:path";
import {
	calculateNewSpecifier,
	findCrossPackageImport,
	findPackageForPath,
	isCrossPackageMove,
	normalizePath,
} from "./resolver.ts";
import type { WorkspaceInfo } from "./workspace.ts";

interface TextChange {
	start: number;
	end: number;
	newText: string;
}

/**
 * Update import specifiers in a file after a module has moved
 *
 * For cross-package moves with workspace info, this will prefer using
 * package imports (e.g., `import { foo } from '@pkg/dest'`) when the
 * destination package can be identified.
 */
export function updateFileReferences(
	sourceFile: ts.SourceFile,
	references: ModuleReference[],
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
	workspace?: WorkspaceInfo,
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const updates: UpdatedReference[] = [];

	// Check if this is a cross-package move
	const crossPackage = workspace
		? isCrossPackageMove(oldPath, newPath, workspace)
		: false;

	for (const ref of references) {
		// For cross-package moves, prefer the package import
		let newSpecifier: string;
		if (crossPackage && workspace) {
			const pkgImport = findCrossPackageImport(newPath, workspace);
			newSpecifier = pkgImport ?? calculateNewSpecifier(
				ref.specifier,
				ref.sourceFile,
				oldPath,
				newPath,
				project,
			);
		} else {
			newSpecifier = calculateNewSpecifier(
				ref.specifier,
				ref.sourceFile,
				oldPath,
				newPath,
				project,
			);
		}

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
 *
 * For cross-package moves with workspace info, this will update the barrel
 * to re-export from the destination package (e.g., `export { foo } from '@pkg/dest'`)
 * rather than using a relative path.
 */
export function updateBarrelExports(
	sourceFile: ts.SourceFile,
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
	workspace?: WorkspaceInfo,
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const updates: UpdatedReference[] = [];

	// Check if this is a cross-package move
	const crossPackage = workspace
		? isCrossPackageMove(oldPath, newPath, workspace)
		: false;

	function visit(node: ts.Node) {
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;

			// For cross-package moves, prefer the package import
			let newSpecifier: string;
			if (crossPackage && workspace) {
				const pkgImport = findCrossPackageImport(newPath, workspace);
				newSpecifier = pkgImport ?? calculateNewSpecifier(
					specifier,
					sourceFile.fileName,
					oldPath,
					newPath,
					project,
				);
			} else {
				newSpecifier = calculateNewSpecifier(
					specifier,
					sourceFile.fileName,
					oldPath,
					newPath,
					project,
				);
			}

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

/**
 * Find the destination barrel file (index.ts) for a moved file
 */
export function findDestinationBarrel(
	targetPath: string,
	workspace: WorkspaceInfo,
): string | null {
	const targetPackage = findPackageForPath(targetPath, workspace);
	if (!targetPackage) {
		return null;
	}

	const pkg = workspace.packages.find((p) => p.name === targetPackage.packageName);
	if (!pkg) {
		return null;
	}

	// Check for index.ts in the src directory
	const srcDir = pkg.srcDir ?? "src";
	const barrelPath = path.join(pkg.path, srcDir, "index.ts");

	return barrelPath;
}

/**
 * Generate an export statement to add to a barrel file for a moved file.
 * Analyzes the existing barrel to match its export style.
 */
export function generateBarrelExport(
	barrelContent: string,
	targetPath: string,
	barrelPath: string,
): { exportStatement: string; insertPosition: number } {
	// Calculate relative path from barrel to target
	const barrelDir = path.dirname(barrelPath);
	let relativePath = path.relative(barrelDir, targetPath);
	relativePath = relativePath.replace(/\.[tj]sx?$/, ""); // Remove extension
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`;
	}

	// Use star export as default style
	const exportStatement = `export * from "${relativePath}";\n`;

	// Find insertion position - after the last export statement
	const lines = barrelContent.split("\n");
	let lastExportLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line?.trim().startsWith("export ")) {
			lastExportLine = i;
		}
	}

	// Calculate character position for insertion
	let insertPosition = 0;
	if (lastExportLine >= 0) {
		// Insert after the last export line
		for (let i = 0; i <= lastExportLine; i++) {
			const line = lines[i];
			if (line !== undefined) {
				insertPosition += line.length + 1; // +1 for newline
			}
		}
	} else {
		// No exports found, insert at end of file
		insertPosition = barrelContent.length;
	}

	return { exportStatement, insertPosition };
}

/**
 * Add an export to the destination barrel file for a moved file
 */
export function addExportToDestinationBarrel(
	barrelContent: string,
	targetPath: string,
	barrelPath: string,
): { newContent: string; update: UpdatedReference } {
	const { exportStatement, insertPosition } = generateBarrelExport(
		barrelContent,
		targetPath,
		barrelPath,
	);

	// Check if this export already exists
	const relativePath = exportStatement.match(/"([^"]+)"/)?.[1];
	if (relativePath && barrelContent.includes(`from "${relativePath}"`)) {
		// Export already exists, no change needed
		return {
			newContent: barrelContent,
			update: {
				file: barrelPath,
				line: 0,
				oldSpecifier: "",
				newSpecifier: relativePath,
			},
		};
	}

	const newContent =
		barrelContent.slice(0, insertPosition) +
		exportStatement +
		barrelContent.slice(insertPosition);

	// Count lines to find where we inserted
	const linesBeforeInsert = barrelContent.slice(0, insertPosition).split("\n").length;

	return {
		newContent,
		update: {
			file: barrelPath,
			line: linesBeforeInsert + 1,
			oldSpecifier: "(new export)",
			newSpecifier: relativePath ?? "",
		},
	};
}
