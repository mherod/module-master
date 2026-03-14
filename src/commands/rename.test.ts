import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { renameInSourceFile } from "./rename";

function parse(source: string): ts.SourceFile {
	return ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
}

function rename(source: string, oldName: string, newName: string): string {
	const sf = parse(source);
	return renameInSourceFile(sf, oldName, newName).newContent;
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
});
