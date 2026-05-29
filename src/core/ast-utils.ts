/**
 * Abstraction boundary for the TypeScript Compiler API.
 *
 * Command-layer files should import `ts` from here rather than directly from
 * `"typescript"`. This ensures that if the underlying parser ever changes,
 * only the `core/` layer needs to be updated.
 */
import ts from "typescript";

export { default } from "typescript";

/**
 * Check whether an AST node carries a given modifier keyword (such as
 * `export` or `default`). Returns false for nodes that cannot have modifiers.
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	if (!ts.canHaveModifiers(node)) {
		return false;
	}
	return (
		ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false
	);
}

/** Check whether an AST node has the `export` modifier keyword. */
export function hasExportModifier(node: ts.Node): boolean {
	return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/** Check whether an AST node has the `default` modifier keyword. */
export function hasDefaultModifier(node: ts.Node): boolean {
	return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}
