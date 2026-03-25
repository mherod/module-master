import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { renameInSourceFile } from "./rename";

function buildProgram(source: string): {
	program: ts.Program;
	sourceFile: ts.SourceFile;
} {
	const fileName = "/virtual/test.ts";
	const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext };
	const host = ts.createCompilerHost(options, true);
	host.getSourceFile = (name, languageVersion) => {
		if (name === fileName) {
			return ts.createSourceFile(name, source, languageVersion, true);
		}
		return undefined;
	};
	host.readFile = (name) => (name === fileName ? source : undefined);
	host.fileExists = (name) => name === fileName;
	host.writeFile = () => undefined;

	const program = ts.createProgram([fileName], options, host);
	const sourceFile = program.getSourceFile(fileName);
	if (!sourceFile) {
		throw new Error("Failed to create source file");
	}
	return { program, sourceFile };
}

function getExportedSymbol(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	name: string
): ts.Symbol | null {
	let found: ts.Symbol | null = null;
	const visit = (node: ts.Node) => {
		if (found) {
			return;
		}
		if (
			ts.isFunctionDeclaration(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
			node.name?.text === name
		) {
			found = checker.getSymbolAtLocation(node.name) ?? null;
			return;
		}
		if (
			ts.isVariableStatement(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.name.text === name) {
					found = checker.getSymbolAtLocation(decl.name) ?? null;
					return;
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function rename(source: string, oldName: string, newName: string): string {
	const { program, sourceFile } = buildProgram(source);
	const checker = program.getTypeChecker();
	const renamedSymbol = getExportedSymbol(sourceFile, checker, oldName);
	return renameInSourceFile(sourceFile, oldName, newName, {
		checker,
		renamedSymbol: renamedSymbol ?? undefined,
	}).newContent;
}

describe("renameInSourceFile — shadowing", () => {
	test("renames exported function declaration", () => {
		const src = "export function foo() { return 42; }";
		expect(rename(src, "foo", "bar")).toBe(
			"export function bar() { return 42; }"
		);
	});

	test("renames self-recursive exported function", () => {
		const src = "export function foo() { return foo(); }";
		expect(rename(src, "foo", "bar")).toBe(
			"export function bar() { return bar(); }"
		);
	});

	test("does not rename shadowed parameter declaration", () => {
		const src = [
			"export function foo() { return 42; }",
			"function bar(foo: number) { return foo * 2; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		// exported declaration renamed
		expect(result).toContain("export function baz()");
		// parameter declaration left unchanged
		expect(result).toContain("function bar(foo: number)");
		// parameter usage left unchanged
		expect(result).toContain("return foo * 2");
	});

	test("does not rename usages inside a function with shadowing parameter", () => {
		const src = [
			"export const foo = 1;",
			"function inner(foo: string) { return foo.length; }",
		].join("\n");
		const result = rename(src, "foo", "qux");
		expect(result).toContain("export const qux = 1");
		expect(result).toContain("function inner(foo: string)");
		expect(result).toContain("return foo.length");
	});

	test("does not rename destructured parameter with same name", () => {
		const src = [
			"export function foo() {}",
			"function bar({ foo }: { foo: number }) { return foo + 1; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		expect(result).toContain("function bar({ foo }");
		expect(result).toContain("return foo + 1");
	});

	test("does not rename inner function declaration with same name", () => {
		const src = [
			"export function foo() { return 1; }",
			"function outer() { function foo() { return 2; } return foo(); }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		// inner function declaration not renamed
		expect(result).toContain("function foo()");
	});

	test("renames real references to export outside any shadowed scope", () => {
		const src = [
			"export function foo() {}",
			"const ref = foo;",
			"function bar(foo: number) { return foo; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		expect(result).toContain("const ref = baz");
		expect(result).toContain("function bar(foo: number)");
		expect(result).toContain("return foo");
	});

	test("does not rename variable declaration with same name", () => {
		const src = [
			"export const foo = 1;",
			"function bar() { const foo = 2; return foo; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export const baz = 1");
		// inner declaration left unchanged
		expect(result).toContain("const foo = 2");
	});

	test("renames shorthand object properties that reference the export", () => {
		const src = ["export const foo = 1;", "const obj = { foo };"].join("\n");
		const result = rename(src, "foo", "bar");
		expect(result).toContain("export const bar = 1");
		expect(result).toContain("const obj = { bar }");
	});
});
