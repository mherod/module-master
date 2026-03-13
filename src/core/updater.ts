import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import type {
	ExportInfo,
	ImportBinding,
	ModuleReference,
	ProjectConfig,
	UpdatedReference,
} from "../types.ts";
import {
	calculateNewSpecifier,
	findCrossPackageImport,
	findPackageForPath,
	isCrossPackageMove,
	normalizePath,
	resolveModuleSpecifier,
} from "./resolver.ts";
import type { TextChange } from "./text-changes.ts";

// Note: We use TextChange type from shared module but implement specialized
// application logic here due to complex import split and removal handling
import type { WorkspaceInfo } from "./workspace.ts";

/**
 * Options for cross-package move handling
 */
export interface CrossPackageMoveContext {
	/** Exports from the file being moved */
	movedFileExports: ExportInfo[];
	/** Whether this is a barrel-based reference */
	isBarrelReference: boolean;
}

/**
 * Update import specifiers in a file after a module has moved
 *
 * For cross-package moves with workspace info, this will prefer using
 * package imports (e.g., `import { foo } from '@pkg/dest'`) when the
 * destination package can be identified.
 *
 * When imports go through a barrel and only some bindings come from the moved file,
 * this will split the import into two: one for moved exports, one for remaining exports.
 */
export function updateFileReferences(
	sourceFile: ts.SourceFile,
	references: ModuleReference[],
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
	workspace?: WorkspaceInfo,
	movedFileExports?: ExportInfo[]
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const updates: UpdatedReference[] = [];
	const importSplits: ImportSplitChange[] = [];

	// Check if this is a cross-package move
	const crossPackage = workspace
		? isCrossPackageMove(oldPath, newPath, workspace)
		: false;

	// Get the set of export names from the moved file for binding matching
	const movedExportNames = new Set(movedFileExports?.map((e) => e.name) ?? []);

	for (const ref of references) {
		// Check if this is an indirect reference through a barrel
		// (reference specifier doesn't directly point to the moved file)
		const isBarrelReference =
			crossPackage &&
			movedFileExports &&
			movedFileExports.length > 0 &&
			ref.bindings &&
			ref.bindings.length > 0 &&
			normalizePath(ref.resolvedPath) === normalizePath(oldPath);

		// For barrel references with mixed bindings, we need to split the import
		if (isBarrelReference && ref.bindings) {
			const movedBindings: ImportBinding[] = [];
			const remainingBindings: ImportBinding[] = [];

			for (const binding of ref.bindings) {
				// Check if this binding comes from the moved file
				if (movedExportNames.has(binding.name)) {
					movedBindings.push(binding);
				} else {
					remainingBindings.push(binding);
				}
			}

			// If we have mixed bindings, split the import
			if (movedBindings.length > 0 && remainingBindings.length > 0) {
				const newSpecifier = workspace
					? (findCrossPackageImport(newPath, workspace) ?? ref.specifier)
					: ref.specifier;

				const splitChange =
					createImportSplit(
						sourceFile,
						ref,
						movedBindings,
						remainingBindings,
						newSpecifier
					) ??
					createExportSplit(
						sourceFile,
						ref,
						movedBindings,
						remainingBindings,
						newSpecifier
					);

				if (splitChange) {
					importSplits.push(splitChange);
					updates.push({
						file: ref.sourceFile,
						line: ref.line,
						oldSpecifier: ref.specifier,
						newSpecifier: `${ref.specifier} + ${newSpecifier}`,
					});
				}
				continue;
			}

			// All bindings are moved, update the whole import
			if (movedBindings.length > 0 && remainingBindings.length === 0) {
				const newSpecifier = workspace
					? (findCrossPackageImport(newPath, workspace) ?? ref.specifier)
					: ref.specifier;

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
				continue;
			}

			// No bindings are moved (shouldn't happen, but skip)
			if (movedBindings.length === 0) {
				continue;
			}
		}

		// For cross-package moves, export-all and export-from should be REMOVED
		// (not changed to package import, which would pull in everything)
		const isExportReference =
			ref.type === "export-all" ||
			ref.type === "export-from" ||
			ref.type === "export-all-as";

		if (crossPackage && isExportReference) {
			// Remove the entire export declaration
			const removal = findExportDeclarationRange(sourceFile, ref);
			if (removal) {
				importSplits.push(removal); // Reuse importSplits for removals
				updates.push({
					file: ref.sourceFile,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier: "(removed - exported from destination package)",
				});
			}
			continue;
		}

		// Standard case: update specifier directly
		let newSpecifier: string;
		if (crossPackage && workspace) {
			const pkgImport = findCrossPackageImport(newPath, workspace);
			newSpecifier =
				pkgImport ??
				calculateNewSpecifier(
					ref.specifier,
					ref.sourceFile,
					oldPath,
					newPath,
					project
				);
		} else {
			newSpecifier = calculateNewSpecifier(
				ref.specifier,
				ref.sourceFile,
				oldPath,
				newPath,
				project
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

	// Apply import splits first (they replace entire import statements)
	// Sort by position descending to maintain positions
	importSplits.sort((a, b) => b.start - a.start);

	let newContent = sourceFile.text;
	for (const split of importSplits) {
		newContent =
			newContent.slice(0, split.start) +
			split.newText +
			newContent.slice(split.end);
	}

	// Apply specifier changes in reverse order to maintain positions
	// Adjust positions if import splits were applied
	changes.sort((a, b) => b.start - a.start);

	for (const change of changes) {
		// Skip changes that overlap with import splits (already handled)
		const overlapsWithSplit = importSplits.some(
			(split) => change.start >= split.start && change.end <= split.end
		);
		if (overlapsWithSplit) {
			continue;
		}

		newContent =
			newContent.slice(0, change.start) +
			change.newText +
			newContent.slice(change.end);
	}

	return { newContent, updates };
}

interface ImportSplitChange {
	start: number;
	end: number;
	newText: string;
}

/**
 * Create an import split change that replaces a single import with two imports
 */
function createImportSplit(
	sourceFile: ts.SourceFile,
	ref: ModuleReference,
	movedBindings: ImportBinding[],
	remainingBindings: ImportBinding[],
	newSpecifier: string
): ImportSplitChange | null {
	// Find the import declaration node position
	let nodePosition: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (nodePosition) {
			return;
		}

		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === ref.specifier
		) {
			const start = node.getStart(sourceFile);
			const { line } = sourceFile.getLineAndCharacterOfPosition(start);
			if (line + 1 === ref.line) {
				nodePosition = { start, end: node.getEnd() };
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	if (!nodePosition) {
		return null;
	}

	// Generate the two new import statements
	const movedBindingStr = movedBindings
		.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
		.join(", ");
	const remainingBindingStr = remainingBindings
		.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
		.join(", ");

	// Determine if type-only
	const movedTypeOnly = movedBindings.every((b) => b.isType);
	const remainingTypeOnly = remainingBindings.every((b) => b.isType);

	const movedImport = movedTypeOnly
		? `import type { ${movedBindingStr} } from "${newSpecifier}";`
		: `import { ${movedBindingStr} } from "${newSpecifier}";`;

	const remainingImport = remainingTypeOnly
		? `import type { ${remainingBindingStr} } from "${ref.specifier}";`
		: `import { ${remainingBindingStr} } from "${ref.specifier}";`;

	// Get the full import statement range including any leading whitespace on the line
	const { start, end } = nodePosition;

	// Preserve indentation
	const lineStart = sourceFile.getLineAndCharacterOfPosition(start);
	const indent = sourceFile.text.slice(start - lineStart.character, start);

	return {
		start,
		end,
		newText: `${movedImport}\n${indent}${remainingImport}`,
	};
}

/**
 * Create an export split change that replaces a single re-export with two re-exports.
 * Handles: export { a, b } from './module' → export { a } from '@pkg/new'; export { b } from './module';
 * Preserves isTypeOnly on each generated export clause.
 */
function createExportSplit(
	sourceFile: ts.SourceFile,
	ref: ModuleReference,
	movedBindings: ImportBinding[],
	remainingBindings: ImportBinding[],
	newSpecifier: string
): ImportSplitChange | null {
	let nodePosition: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (nodePosition) {
			return;
		}

		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === ref.specifier
		) {
			const start = node.getStart(sourceFile);
			const { line } = sourceFile.getLineAndCharacterOfPosition(start);
			if (line + 1 === ref.line) {
				nodePosition = { start, end: node.getEnd() };
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	if (!nodePosition) {
		return null;
	}

	const movedBindingStr = movedBindings
		.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
		.join(", ");
	const remainingBindingStr = remainingBindings
		.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
		.join(", ");

	const movedTypeOnly = movedBindings.every((b) => b.isType);
	const remainingTypeOnly = remainingBindings.every((b) => b.isType);

	const movedExport = movedTypeOnly
		? `export type { ${movedBindingStr} } from "${newSpecifier}";`
		: `export { ${movedBindingStr} } from "${newSpecifier}";`;

	const remainingExport = remainingTypeOnly
		? `export type { ${remainingBindingStr} } from "${ref.specifier}";`
		: `export { ${remainingBindingStr} } from "${ref.specifier}";`;

	const { start, end } = nodePosition;
	const lineStart = sourceFile.getLineAndCharacterOfPosition(start);
	const indent = sourceFile.text.slice(start - lineStart.character, start);

	return {
		start,
		end,
		newText: `${movedExport}\n${indent}${remainingExport}`,
	};
}

/**
 * Find the range of an export declaration to remove it entirely
 */
function findExportDeclarationRange(
	sourceFile: ts.SourceFile,
	ref: ModuleReference
): ImportSplitChange | null {
	let result: ImportSplitChange | null = null;

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === ref.specifier
		) {
			const start = node.getStart(sourceFile);
			const { line } = sourceFile.getLineAndCharacterOfPosition(start);
			if (line + 1 === ref.line) {
				let end = node.getEnd();
				// Include trailing newline if present
				if (sourceFile.text[end] === "\n") {
					end++;
				}
				result = { start, end, newText: "" };
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

/**
 * Find the exact location of a module specifier in the source
 */
export function findSpecifierLocation(
	sourceFile: ts.SourceFile,
	ref: ModuleReference
): { start: number; end: number } | null {
	let result: { start: number; end: number } | null = null;

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		// Check import declarations
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === ref.specifier
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (line + 1 === ref.line) {
				// +1 to skip opening quote, -1 to skip closing quote
				result = {
					start: node.moduleSpecifier.getStart(sourceFile) + 1,
					end: node.moduleSpecifier.getEnd() - 1,
				};
			}
		}

		// Check export declarations
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === ref.specifier
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (line + 1 === ref.line) {
				result = {
					start: node.moduleSpecifier.getStart(sourceFile) + 1,
					end: node.moduleSpecifier.getEnd() - 1,
				};
			}
		}

		// Check dynamic imports and require calls
		if (ts.isCallExpression(node)) {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteral(arg) && arg.text === ref.specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
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
 * For cross-package moves, this removes the re-export from the source barrel
 * since the destination package's barrel will export the moved file.
 * Consumers should import directly from the new package.
 *
 * For same-package moves, this updates the path in the re-export.
 */
export function updateBarrelExports(
	sourceFile: ts.SourceFile,
	oldPath: string,
	newPath: string,
	project: ProjectConfig,
	workspace?: WorkspaceInfo
): { newContent: string; updates: UpdatedReference[] } {
	const changes: TextChange[] = [];
	const removals: { start: number; end: number }[] = [];
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

			// Resolve the specifier to see if it points to the moved file
			const resolved = resolveModuleSpecifier(
				specifier,
				sourceFile.fileName,
				project
			);

			// Only process if this export points to the file being moved
			if (resolved.kind !== "resolved") {
				if (resolved.kind === "unresolvable") {
					logger.error(
						`Warning: cannot resolve "${specifier}" from ${sourceFile.fileName}`
					);
				}
				ts.forEachChild(node, visit);
				return;
			}
			if (normalizePath(resolved.path) !== normalizePath(oldPath)) {
				ts.forEachChild(node, visit);
				return;
			}

			// For cross-package moves, remove the re-export entirely
			// The destination barrel will export it, consumers import from there
			if (crossPackage) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);

				// Find the full line including newline to remove cleanly
				const start = node.getStart(sourceFile);
				let end = node.getEnd();
				// Include trailing newline if present
				if (sourceFile.text[end] === "\n") {
					end++;
				}

				removals.push({ start, end });

				updates.push({
					file: sourceFile.fileName,
					line: line + 1,
					oldSpecifier: specifier,
					newSpecifier: "(removed - exported from destination package)",
				});
				return;
			}

			// For same-package moves, update the path
			const newSpecifier = calculateNewSpecifier(
				specifier,
				sourceFile.fileName,
				oldPath,
				newPath,
				project
			);

			if (newSpecifier !== specifier) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
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

	// Apply removals first (in reverse order)
	removals.sort((a, b) => b.start - a.start);
	let newContent = sourceFile.text;
	for (const removal of removals) {
		newContent =
			newContent.slice(0, removal.start) + newContent.slice(removal.end);
	}

	// Then apply specifier changes (adjust positions if removals happened)
	// Note: if we removed lines, the positions are now invalid
	// So we only apply changes if there were no removals
	if (removals.length === 0) {
		changes.sort((a, b) => b.start - a.start);
		for (const change of changes) {
			newContent =
				newContent.slice(0, change.start) +
				change.newText +
				newContent.slice(change.end);
		}
	}

	return { newContent, updates };
}

/**
 * Find the destination barrel file (index.ts) for a moved file
 */
export function findDestinationBarrel(
	targetPath: string,
	workspace: WorkspaceInfo
): string | null {
	const targetPackage = findPackageForPath(targetPath, workspace);
	if (!targetPackage) {
		return null;
	}

	const pkg = workspace.packages.find(
		(p) => p.name === targetPackage.packageName
	);
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
	barrelPath: string
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
	barrelPath: string
): { newContent: string; update: UpdatedReference } {
	const { exportStatement, insertPosition } = generateBarrelExport(
		barrelContent,
		targetPath,
		barrelPath
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
	const linesBeforeInsert = barrelContent
		.slice(0, insertPosition)
		.split("\n").length;

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
