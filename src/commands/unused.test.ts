import { describe, expect, test } from "bun:test";
import { createSourceFileFromText } from "../core/source-file.ts";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";
import { countInternalReferences } from "./unused.ts";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`unused-${name}`, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true },
			include: ["**/*.ts"],
		}),
		...files,
	});
}

describe("unused command", () => {
	test("reports no unused exports when all are consumed", async () => {
		const dir = await makeFixture("all-used", {
			"utils.ts": 'export function helper() { return "ok"; }',
			"main.ts": 'import { helper } from "./utils";\nconsole.log(helper());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);
		expect(report.totalExports).toBeGreaterThanOrEqual(1);

		await cleanup(dir);
	});

	test("detects unused named exports", async () => {
		const dir = await makeFixture("unused-named", {
			"utils.ts":
				"export function used() { return 1; }\nexport function unused() { return 2; }",
			"main.ts": 'import { used } from "./utils";\nconsole.log(used());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused.map((u: { name: string }) => u.name);
		expect(unusedNames).toContain("unused");
		expect(unusedNames).not.toContain("used");

		await cleanup(dir);
	});

	test("namespace import marks all exports as used", async () => {
		const dir = await makeFixture("namespace", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"main.ts": 'import * as utils from "./utils";\nconsole.log(utils.a());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);

		await cleanup(dir);
	});

	test("human-readable output shows file grouping", async () => {
		const dir = await makeFixture("readable", {
			"utils.ts":
				'export function orphan() { return "dead"; }\nexport const UNUSED_CONST = 42;',
		});

		const proc = Bun.spawn([...CLI, "unused", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("unused export");
		expect(stdout).toContain("orphan");

		await cleanup(dir);
	});

	test("--ignore excludes matching files from scan", async () => {
		const dir = await makeFixture("ignore", {
			"utils.ts": "export function helper() { return 1; }",
			"utils.test.ts": 'export function testHelper() { return "test"; }',
			"main.ts": 'import { helper } from "./utils";\nconsole.log(helper());',
		});

		const proc = Bun.spawn(
			[...CLI, "unused", dir, "--json", "--ignore=*.test.ts"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const files = report.unused.map((u: { file: string }) => u.file);
		for (const f of files) {
			expect(f).not.toContain(".test.ts");
		}

		await cleanup(dir);
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "unused"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("unused requires a <directory> argument");
	});

	test("reports zero unused for empty project", async () => {
		const dir = await makeFixture("empty", {});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);

		await cleanup(dir);
	});

	test("--verbose produces output with extra spacing", async () => {
		const dir = await makeFixture("verbose", {
			"utils.ts":
				'export function orphanA() { return "a"; }\nexport function orphanB() { return "b"; }',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("orphanA");
		expect(stdout).toContain("orphanB");
		expect(stdout).toContain("unused export");

		await cleanup(dir);
	});

	test("detects unused default exports", async () => {
		const dir = await makeFixture("default-export", {
			"utils.ts": "export default function main() { return 42; }",
			"other.ts": 'export const x = "not importing utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const defaultUnused = report.unused.find(
			(u: { type: string }) => u.type === "default"
		);
		expect(defaultUnused).toBeDefined();

		await cleanup(dir);
	});

	test("default import marks default export as used", async () => {
		const dir = await makeFixture("default-used", {
			"utils.ts": "export default function main() { return 42; }",
			"consumer.ts": 'import main from "./utils";\nconsole.log(main());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const defaultUnused = report.unused.find(
			(u: { file: string; type: string }) =>
				u.file.includes("utils.ts") && u.type === "default"
		);
		expect(defaultUnused).toBeUndefined();

		await cleanup(dir);
	});

	test("detects unused type exports", async () => {
		const dir = await makeFixture("type-export", {
			"types.ts":
				"export type UsedType = string;\nexport type UnusedType = number;",
			"consumer.ts":
				'import type { UsedType } from "./types";\nconst x: UsedType = "hi";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused.map((u: { name: string }) => u.name);
		expect(unusedNames).toContain("UnusedType");
		expect(unusedNames).not.toContain("UsedType");

		await cleanup(dir);
	});

	test("export-all (re-export) marks all exports as used", async () => {
		const dir = await makeFixture("reexport", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"index.ts": 'export * from "./utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("utils.ts")
		);
		expect(utilsUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("aliased named import marks original export as used", async () => {
		const dir = await makeFixture("alias-import", {
			"utils.ts":
				"export function original() { return 1; }\nexport function other() { return 2; }",
			"consumer.ts":
				'import { original as renamed } from "./utils";\nconsole.log(renamed());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused
			.filter((u: { file: string }) => u.file.includes("utils.ts"))
			.map((u: { name: string }) => u.name);
		// "original" is used (via alias), "other" is not
		expect(unusedNames).not.toContain("original");
		expect(unusedNames).toContain("other");

		await cleanup(dir);
	});

	test("aliased re-export marks original export as used", async () => {
		const dir = await makeFixture("alias-reexport", {
			"utils.ts":
				"export function helper() { return 1; }\nexport function unused() { return 2; }",
			"barrel.ts": 'export { helper as renamedHelper } from "./utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused
			.filter((u: { file: string }) => u.file.includes("utils.ts"))
			.map((u: { name: string }) => u.name);
		expect(utilsUnused).not.toContain("helper");
		expect(utilsUnused).toContain("unused");

		await cleanup(dir);
	});

	test("dynamic import marks all exports as used", async () => {
		const dir = await makeFixture("dynamic-import", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"loader.ts":
				'async function load() { const mod = await import("./utils"); return mod.a(); }',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("utils.ts")
		);
		expect(utilsUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("--json report includes totalExports and totalFiles", async () => {
		const dir = await makeFixture("report-fields", {
			"a.ts": "export function fnA() { return 1; }",
			"b.ts": "export function fnB() { return 2; }",
			"c.ts":
				'import { fnA } from "./a";\nimport { fnB } from "./b";\nconsole.log(fnA(), fnB());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.totalExports).toBeGreaterThanOrEqual(2);
		expect(report.totalFiles).toBeGreaterThanOrEqual(3);

		await cleanup(dir);
	});

	test("export-all-as marks all exports as used", async () => {
		const dir = await makeFixture("export-all-as", {
			"math.ts":
				"export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }",
			"index.ts": 'export * as math from "./math";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const mathUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("math.ts")
		);
		expect(mathUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("distinguishes internal-only exports from genuinely dead exports", async () => {
		// Reproduces issue #58: an export referenced only within its own file
		// must be flagged as a de-export candidate, not lumped in with exports
		// referenced nowhere at all.
		const dir = await makeFixture("internal-usage", {
			"utils.ts": [
				"export function isServerComponent(filename: string): boolean {",
				"  return isAppRouterComponent(filename);",
				"}",
				"export function isAppRouterComponent(filename: string): boolean {",
				'  return filename.includes("app/");',
				"}",
				"export function trulyDead(): number {",
				"  return 42;",
				"}",
			].join("\n"),
			"main.ts":
				'import { isServerComponent } from "./utils";\nconsole.log(isServerComponent("x"));',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);

		interface Entry {
			name: string;
			internalUsage: boolean;
			internalRefCount: number;
		}
		const find = (name: string): Entry | undefined =>
			report.unused.find((u: Entry) => u.name === name);

		// Used cross-file — not reported at all.
		expect(find("isServerComponent")).toBeUndefined();

		// Exported but only consumed within its own file — de-export candidate.
		const internalOnly = find("isAppRouterComponent");
		expect(internalOnly).toBeDefined();
		expect(internalOnly?.internalUsage).toBe(true);
		expect(internalOnly?.internalRefCount).toBeGreaterThanOrEqual(1);

		// Referenced nowhere — safe to delete.
		const dead = find("trulyDead");
		expect(dead).toBeDefined();
		expect(dead?.internalUsage).toBe(false);
		expect(dead?.internalRefCount).toBe(0);

		expect(report.internalOnlyCount).toBeGreaterThanOrEqual(1);
		expect(report.deadCount).toBeGreaterThanOrEqual(1);

		await cleanup(dir);
	});
});

describe("countInternalReferences", () => {
	const parse = (text: string) =>
		createSourceFileFromText("internal-ref.ts", text);

	test("counts same-file references excluding declaration and export statement", () => {
		const sf = parse(
			[
				"export function caller() {",
				"  return helper();",
				"}",
				"export function helper() {",
				"  return 1;",
				"}",
			].join("\n")
		);
		const count = countInternalReferences(sf, {
			name: "helper",
			type: "named",
			isType: false,
			line: 4,
		});
		expect(count).toBe(1);
	});

	test("returns 0 for a symbol referenced only by its declaration", () => {
		const sf = parse("export function lonely() {\n  return 1;\n}");
		const count = countInternalReferences(sf, {
			name: "lonely",
			type: "named",
			isType: false,
			line: 1,
		});
		expect(count).toBe(0);
	});

	test("does not count property accesses of the same name", () => {
		const sf = parse(
			[
				"export function value() {",
				"  return 1;",
				"}",
				"const obj = { value: 2 };",
				"export const total = obj.value;",
			].join("\n")
		);
		const count = countInternalReferences(sf, {
			name: "value",
			type: "named",
			isType: false,
			line: 1,
		});
		expect(count).toBe(0);
	});

	test("does not count the trailing export specifier as usage", () => {
		const sf = parse(
			["function helper() {", "  return 1;", "}", "export { helper };"].join(
				"\n"
			)
		);
		const count = countInternalReferences(sf, {
			name: "helper",
			type: "named",
			isType: false,
			line: 4,
		});
		expect(count).toBe(0);
	});
});
