import ts from "typescript";
import type {
	BarrelExport,
	BarrelExportEntry,
	ExportInfo,
	ImportBinding,
	ModuleReference,
	ProjectConfig,
	ReferenceType,
} from "../types.ts";
import { resolveModulePath } from "./resolver.ts";

/**
 * Scan a source file for all module references (imports and exports)
 */
export function scanModuleReferences(
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference[] {
	const references: ModuleReference[] = [];

	function visit(node: ts.Node) {
		const ref = extractReference(node, sourceFile, project);
		if (ref) {
			references.push(ref);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return references;
}

/**
 * Extract a module reference from a node if applicable
 */
function extractReference(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference | null {
	// import ... from '...'
	if (ts.isImportDeclaration(node)) {
		return extractImportDeclaration(node, sourceFile, project);
	}

	// export ... from '...'
	if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
		return extractExportDeclaration(node, sourceFile, project);
	}

	// Dynamic import: import('...')
	if (ts.isCallExpression(node)) {
		if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			return extractDynamicImport(node, sourceFile, project);
		}

		// require('...') or require.resolve('...')
		if (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "require"
		) {
			return extractRequire(node, sourceFile, project, "require");
		}

		if (
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "require" &&
			node.expression.name.text === "resolve"
		) {
			return extractRequire(node, sourceFile, project, "require-resolve");
		}

		// jest.mock('...') or vi.mock('...')
		if (
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			ts.isIdentifier(node.expression.name)
		) {
			const obj = node.expression.expression.text;
			const prop = node.expression.name.text;
			if (
				(obj === "jest" || obj === "vi" || obj === "vitest") &&
				(prop === "mock" || prop === "doMock" || prop === "unmock")
			) {
				return extractRequire(node, sourceFile, project, "jest-mock");
			}
		}
	}

	return null;
}

function extractImportDeclaration(
	node: ts.ImportDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference | null {
	if (!ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	const specifier = node.moduleSpecifier.text;
	const resolvedPath = resolveModulePath(
		specifier,
		sourceFile.fileName,
		project
	);

	if (!resolvedPath) {
		return null; // External package or unresolvable
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);
	const isTypeOnly = node.importClause?.isTypeOnly ?? false;

	let type: ReferenceType = "import";
	const bindings: ImportBinding[] = [];

	if (!node.importClause) {
		type = "import-side-effect";
	} else if (node.importClause.namedBindings) {
		if (ts.isNamespaceImport(node.importClause.namedBindings)) {
			type = "import-namespace";
			bindings.push({
				name: node.importClause.namedBindings.name.text,
				isType: isTypeOnly,
			});
		} else if (ts.isNamedImports(node.importClause.namedBindings)) {
			type = "import-named";
			for (const element of node.importClause.namedBindings.elements) {
				bindings.push({
					name: element.propertyName?.text ?? element.name.text,
					alias: element.propertyName ? element.name.text : undefined,
					isType: element.isTypeOnly || isTypeOnly,
				});
			}
		}
	}

	// Handle default import
	if (node.importClause?.name) {
		bindings.unshift({
			name: "default",
			alias: node.importClause.name.text,
			isType: isTypeOnly,
		});
	}

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath,
		type,
		line: line + 1,
		column: character + 1,
		bindings: bindings.length > 0 ? bindings : undefined,
		isTypeOnly,
	};
}

function extractExportDeclaration(
	node: ts.ExportDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference | null {
	if (!(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))) {
		return null;
	}

	const specifier = node.moduleSpecifier.text;
	const resolvedPath = resolveModulePath(
		specifier,
		sourceFile.fileName,
		project
	);

	if (!resolvedPath) {
		return null;
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);
	const isTypeOnly = node.isTypeOnly;

	let type: ReferenceType;
	const bindings: ImportBinding[] = [];

	if (!node.exportClause) {
		type = "export-all";
	} else if (ts.isNamespaceExport(node.exportClause)) {
		type = "export-all-as";
		bindings.push({
			name: node.exportClause.name.text,
			isType: isTypeOnly,
		});
	} else {
		type = "export-from";
		for (const element of node.exportClause.elements) {
			bindings.push({
				name: element.propertyName?.text ?? element.name.text,
				alias: element.propertyName ? element.name.text : undefined,
				isType: element.isTypeOnly || isTypeOnly,
			});
		}
	}

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath,
		type,
		line: line + 1,
		column: character + 1,
		bindings: bindings.length > 0 ? bindings : undefined,
		isTypeOnly,
	};
}

function extractDynamicImport(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference | null {
	const arg = node.arguments[0];
	if (!(arg && ts.isStringLiteral(arg))) {
		return null; // Dynamic specifier, can't statically analyze
	}

	const specifier = arg.text;
	const resolvedPath = resolveModulePath(
		specifier,
		sourceFile.fileName,
		project
	);

	if (!resolvedPath) {
		return null;
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath,
		type: "import-dynamic",
		line: line + 1,
		column: character + 1,
		isTypeOnly: false,
	};
}

function extractRequire(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	type: "require" | "require-resolve" | "jest-mock"
): ModuleReference | null {
	const arg = node.arguments[0];
	if (!(arg && ts.isStringLiteral(arg))) {
		return null;
	}

	const specifier = arg.text;
	const resolvedPath = resolveModulePath(
		specifier,
		sourceFile.fileName,
		project
	);

	if (!resolvedPath) {
		return null;
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath,
		type,
		line: line + 1,
		column: character + 1,
		isTypeOnly: false,
	};
}

/**
 * Scan a source file for all exports
 */
export function scanExports(sourceFile: ts.SourceFile): ExportInfo[] {
	const exports: ExportInfo[] = [];

	function visit(node: ts.Node) {
		// export const/let/var x = ...
		if (ts.isVariableStatement(node) && hasExportModifier(node)) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile)
					);
					exports.push({
						name: decl.name.text,
						type: "named",
						isType: false,
						line: line + 1,
					});
				}
			}
		}

		// export function x() {}
		if (
			ts.isFunctionDeclaration(node) &&
			hasExportModifier(node) &&
			node.name
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			const isDefault =
				node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ??
				false;
			exports.push({
				name: node.name.text,
				type: isDefault ? "default" : "named",
				isType: false,
				line: line + 1,
			});
		}

		// export class X {}
		if (ts.isClassDeclaration(node) && hasExportModifier(node) && node.name) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			const isDefault =
				node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ??
				false;
			exports.push({
				name: node.name.text,
				type: isDefault ? "default" : "named",
				isType: false,
				line: line + 1,
			});
		}

		// export type X = ...
		if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: true,
				line: line + 1,
			});
		}

		// export interface X {}
		if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: true,
				line: line + 1,
			});
		}

		// export enum X {}
		if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: false,
				line: line + 1,
			});
		}

		// export default ...
		if (ts.isExportAssignment(node) && !node.isExportEquals) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: "default",
				type: "default",
				isType: false,
				line: line + 1,
			});
		}

		// export { x, y } (local exports, not re-exports)
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					element.getStart(sourceFile)
				);
				exports.push({
					name: element.name.text,
					type: "named",
					isType: element.isTypeOnly || node.isTypeOnly,
					line: line + 1,
				});
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return exports;
}

/**
 * Identify barrel file exports (re-exports from other modules)
 */
export function scanBarrelExports(
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): BarrelExport[] {
	const barrels: BarrelExport[] = [];
	const entriesBySource = new Map<string, BarrelExportEntry[]>();

	function visit(node: ts.Node) {
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;
			const resolvedPath = resolveModulePath(
				specifier,
				sourceFile.fileName,
				project
			);

			if (!resolvedPath) {
				return;
			}

			const entries = entriesBySource.get(resolvedPath) ?? [];
			entriesBySource.set(resolvedPath, entries);

			if (!node.exportClause) {
				// export * from '...'
				entries.push({ type: "all", from: specifier });
			} else if (ts.isNamespaceExport(node.exportClause)) {
				// export * as x from '...'
				entries.push({
					type: "all-as",
					name: node.exportClause.name.text,
					from: specifier,
				});
			} else {
				// export { x, y } from '...'
				for (const element of node.exportClause.elements) {
					entries.push({
						type: "named",
						name: element.propertyName?.text ?? element.name.text,
						alias: element.propertyName ? element.name.text : undefined,
						from: specifier,
					});
				}
			}
		}
	}

	ts.forEachChild(sourceFile, visit);

	for (const [resolvedPath, entries] of entriesBySource) {
		barrels.push({
			barrelPath: sourceFile.fileName,
			resolvedPath,
			exports: entries,
		});
	}

	return barrels;
}

export function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts
			.getModifiers(node)
			?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}
