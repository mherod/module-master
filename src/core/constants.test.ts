import { describe, expect, test } from "bun:test";
import {
	EXPORT_STATEMENT_PATTERN,
	FILE_EXTENSION_PATTERN,
	removeExtension,
	TS_JS_EXTENSION_PATTERN,
	TS_JS_EXTENSIONS,
	TSC_ERROR_PATTERN,
} from "./constants.ts";

describe("removeExtension", () => {
	test("removes .ts extension", () => {
		expect(removeExtension("src/foo.ts")).toBe("src/foo");
	});

	test("removes .tsx extension", () => {
		expect(removeExtension("src/foo.tsx")).toBe("src/foo");
	});

	test("removes .js extension", () => {
		expect(removeExtension("src/foo.js")).toBe("src/foo");
	});

	test("removes .jsx extension", () => {
		expect(removeExtension("src/foo.jsx")).toBe("src/foo");
	});

	test("leaves non-TS/JS extensions unchanged", () => {
		expect(removeExtension("src/foo.css")).toBe("src/foo.css");
		expect(removeExtension("src/foo.json")).toBe("src/foo.json");
		expect(removeExtension("src/foo.md")).toBe("src/foo.md");
	});

	test("leaves paths without extension unchanged", () => {
		expect(removeExtension("src/foo")).toBe("src/foo");
	});

	test("handles deep paths", () => {
		expect(removeExtension("a/b/c/d.ts")).toBe("a/b/c/d");
	});

	test("handles just a filename", () => {
		expect(removeExtension("index.ts")).toBe("index");
	});
});

describe("TS_JS_EXTENSION_PATTERN", () => {
	test("matches .ts files", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo.ts")).toBe(true);
	});

	test("matches .tsx files", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo.tsx")).toBe(true);
	});

	test("matches .js files", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo.js")).toBe(true);
	});

	test("matches .jsx files", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo.jsx")).toBe(true);
	});

	test("does not match .css files", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo.css")).toBe(false);
	});

	test("does not match files without extension", () => {
		expect(TS_JS_EXTENSION_PATTERN.test("foo")).toBe(false);
	});
});

describe("TS_JS_EXTENSIONS", () => {
	test("matches .ts", () => {
		expect(TS_JS_EXTENSIONS.test("foo.ts")).toBe(true);
	});

	test("matches .tsx", () => {
		expect(TS_JS_EXTENSIONS.test("foo.tsx")).toBe(true);
	});

	test("matches .mts", () => {
		expect(TS_JS_EXTENSIONS.test("foo.mts")).toBe(true);
	});

	test("matches .cts", () => {
		expect(TS_JS_EXTENSIONS.test("foo.cts")).toBe(true);
	});

	test("matches .mjs", () => {
		expect(TS_JS_EXTENSIONS.test("foo.mjs")).toBe(true);
	});

	test("matches .cjs", () => {
		expect(TS_JS_EXTENSIONS.test("foo.cjs")).toBe(true);
	});

	test("does not match .json", () => {
		expect(TS_JS_EXTENSIONS.test("foo.json")).toBe(false);
	});
});

describe("FILE_EXTENSION_PATTERN", () => {
	test("matches any extension", () => {
		expect(FILE_EXTENSION_PATTERN.test("foo.ts")).toBe(true);
		expect(FILE_EXTENSION_PATTERN.test("foo.css")).toBe(true);
		expect(FILE_EXTENSION_PATTERN.test("foo.json")).toBe(true);
	});

	test("does not match files without extension", () => {
		expect(FILE_EXTENSION_PATTERN.test("foo")).toBe(false);
	});
});

describe("TSC_ERROR_PATTERN", () => {
	test("is the correct string sentinel", () => {
		expect(TSC_ERROR_PATTERN).toBe(": error TS");
	});

	test("is present in a typical tsc error line", () => {
		const line = "src/foo.ts(10,5): error TS2345: Argument of type 'string'";
		expect(line.includes(TSC_ERROR_PATTERN)).toBe(true);
	});

	test("is absent from a warning line", () => {
		const line = "src/foo.ts(10,5): warning TS1234: Some warning";
		expect(line.includes(TSC_ERROR_PATTERN)).toBe(false);
	});
});

describe("EXPORT_STATEMENT_PATTERN", () => {
	const matches = (line: string) => EXPORT_STATEMENT_PATTERN.test(line);

	test("matches export *", () => {
		expect(matches("export * from './foo'")).toBe(true);
	});

	test("matches export { ... }", () => {
		expect(matches("export { Foo, Bar }")).toBe(true);
	});

	test("matches export default", () => {
		expect(matches("export default function foo() {}")).toBe(true);
	});

	test("matches export const", () => {
		expect(matches("export const FOO = 1")).toBe(true);
	});

	test("matches export function", () => {
		expect(matches("export function foo() {}")).toBe(true);
	});

	test("matches export class", () => {
		expect(matches("export class Foo {}")).toBe(true);
	});

	test("matches export type", () => {
		expect(matches("export type Foo = string")).toBe(true);
	});

	test("matches export interface", () => {
		expect(matches("export interface Foo {}")).toBe(true);
	});

	test("matches export enum", () => {
		expect(matches("export enum Color { Red }")).toBe(true);
	});

	test("does not match import statements", () => {
		expect(matches("import { Foo } from './bar'")).toBe(false);
	});

	test("does not match plain variable declarations", () => {
		expect(matches("const foo = 1")).toBe(false);
	});
});
