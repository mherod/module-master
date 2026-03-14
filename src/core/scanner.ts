import ts from "typescript";
import { logger } from "../cli-logger.ts";
import type {
	BarrelExport,
	BarrelExportEntry,
	ExportInfo,
	ImportBinding,
	ModuleReference,
	ProjectConfig,
	ReferenceType,
} from "../types.ts";
import { type ResolveResult, resolveModuleSpecifier } from "./resolver.ts";

/**
 * Warn when a specifier cannot be resolved. External packages are expected
 * and skipped silently; unresolvable specifiers indicate a config or path error.
 */
function warnIfUnresolvable(result: ResolveResult): void {
	if (result.kind === "unresolvable") {
		logger.warn(result.diagnostic);
	}
}

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

export interface UnresolvableDiagnostic {
	specifier: string;
	line: number;
	diagnostic: string;
}

/**
 * Scan a source file for import specifiers that cannot be resolved.
 * Returns structured diagnostics for each unresolvable specifier.
 */
export function scanUnresolvableImports(
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): UnresolvableDiagnostic[] {
	const diagnostics: UnresolvableDiagnostic[] = [];

	function visit(node: ts.Node) {
		let specifierNode: ts.StringLiteral | undefined;

		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifierNode = node.moduleSpecifier;
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifierNode = node.moduleSpecifier;
		}

		if (specifierNode) {
			const resolved = resolveModuleSpecifier(
				specifierNode.text,
				sourceFile.fileName,
				project
			);
			if (resolved.kind === "unresolvable") {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				diagnostics.push({
					specifier: specifierNode.text,
					line: line + 1,
					diagnostic: resolved.diagnostic,
				});
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return diagnostics;
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
			return resolveCallArgument(node, sourceFile, project, "import-dynamic");
		}

		// require('...') or require.resolve('...')
		if (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "require"
		) {
			return resolveCallArgument(node, sourceFile, project, "require");
		}

		if (
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "require" &&
			node.expression.name.text === "resolve"
		) {
			return resolveCallArgument(node, sourceFile, project, "require-resolve");
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
				return resolveCallArgument(node, sourceFile, project, "jest-mock");
			}
		}
	}

	return null;
}

/**
 * Shared helper: resolve a module specifier and compute the source position for
 * an import/export declaration node. Returns null if the specifier is unresolvable.
 */
function resolveDeclarationRef(
	specifier: string,
	node: ts.Node,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): {
	specifier: string;
	resolvedPath: string;
	line: number;
	column: number;
} | null {
	const resolved = resolveModuleSpecifier(
		specifier,
		sourceFile.fileName,
		project
	);
	if (resolved.kind !== "resolved") {
		warnIfUnresolvable(resolved);
		return null;
	}
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);
	return {
		specifier,
		resolvedPath: resolved.path,
		line: line + 1,
		column: character + 1,
	};
}

function extractImportDeclaration(
	node: ts.ImportDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): ModuleReference | null {
	if (!ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	const base = resolveDeclarationRef(
		node.moduleSpecifier.text,
		node,
		sourceFile,
		project
	);
	if (!base) {
		return null;
	}

	const { specifier, resolvedPath, line, column } = base;
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
		line,
		column,
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

	const base = resolveDeclarationRef(
		node.moduleSpecifier.text,
		node,
		sourceFile,
		project
	);
	if (!base) {
		return null;
	}

	const { specifier, resolvedPath, line, column } = base;
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
		line,
		column,
		bindings: bindings.length > 0 ? bindings : undefined,
		isTypeOnly,
	};
}

/**
 * Shared helper for call-expression references (dynamic import, require, jest.mock).
 * Extracts the first string-literal argument, resolves it, and builds a ModuleReference.
 */
function resolveCallArgument(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	type: "import-dynamic" | "require" | "require-resolve" | "jest-mock"
): ModuleReference | null {
	const arg = node.arguments[0];
	if (!(arg && ts.isStringLiteral(arg))) {
		return null; // Dynamic specifier — cannot statically analyze
	}

	const specifier = arg.text;
	const resolved = resolveModuleSpecifier(
		specifier,
		sourceFile.fileName,
		project
	);
	if (resolved.kind !== "resolved") {
		warnIfUnresolvable(resolved);
		return null;
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath: resolved.path,
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
			const resolved = resolveModuleSpecifier(
				specifier,
				sourceFile.fileName,
				project
			);

			if (resolved.kind !== "resolved") {
				warnIfUnresolvable(resolved);
				return;
			}

			const resolvedPath = resolved.path;
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

/**
 * Get the name identifier from a declaration node.
 * Supports function, class, variable (including arrow functions),
 * type alias, interface, enum, and export default declarations.
 */
export function getNameNode(node: ts.Node): ts.Identifier | null {
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
	// Handle VariableDeclaration directly (e.g., const foo = () => {})
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		return node.name;
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
	// Handle export default <identifier> (ExportAssignment)
	if (
		ts.isExportAssignment(node) &&
		!node.isExportEquals &&
		ts.isIdentifier(node.expression)
	) {
		return node.expression;
	}
	return null;
}

/**
 * Read and parse a TypeScript/JavaScript file into a SourceFile.
 * Returns null if the file cannot be read.
 */
export function parseSourceFile(filePath: string): ts.SourceFile | null {
	const content = ts.sys.readFile(filePath);
	if (!content) {
		return null;
	}
	return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}
