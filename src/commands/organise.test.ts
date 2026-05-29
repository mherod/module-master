import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureOutput, cleanup, makeTempDir } from "./__test-helpers.ts";
import { buildOrganiseReport, organiseCommand } from "./organise.ts";

const DIRS: string[] = [];

afterAll(async () => {
	for (const dir of DIRS) {
		await cleanup(dir);
	}
});

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		strict: true,
		module: "Preserve",
		moduleResolution: "bundler",
		allowImportingTsExtensions: true,
		noEmit: true,
	},
	include: ["**/*.ts"],
	exclude: ["node_modules"],
});

async function makeProject(files: Record<string, string>): Promise<string> {
	const dir = await makeTempDir("organise");
	DIRS.push(dir);
	await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
	for (const [relPath, content] of Object.entries(files)) {
		const full = path.join(dir, relPath);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	return dir;
}

describe("organise: clean project", () => {
	it("reports no findings when all files are well-placed", async () => {
		const dir = await makeProject({
			"src/utils/helper.ts": "export function helper() { return 1; }",
			"src/app/app.ts": `import { helper } from "../utils/helper.ts"; helper();`,
			"src/core/core.ts": `import { helper } from "../utils/helper.ts"; helper();`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		expect(report.summary.totalMisplaced).toBe(0);
		expect(report.summary.totalCollisions).toBe(0);
		expect(report.summary.scannedFiles).toBeGreaterThan(0);
	});
});

describe("organise: misplaced files", () => {
	it("flags a helper whose only importers are in a single subdirectory", async () => {
		const dir = await makeProject({
			"src/helper.ts": "export function doWork() { return 42; }",
			"src/core/cookies/a.ts": `import { doWork } from "../../helper.ts"; doWork();`,
			"src/core/cookies/b.ts": `import { doWork } from "../../helper.ts"; doWork();`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		expect(report.summary.totalMisplaced).toBeGreaterThan(0);
		const finding = report.misplacedFiles.find((f) =>
			f.file.includes("helper.ts")
		);
		expect(finding).toBeDefined();
		expect(finding?.suggestedPath).toContain(
			path.join("src", "core", "cookies")
		);
	});

	it("does not flag a file imported from multiple directories", async () => {
		const dir = await makeProject({
			"src/shared.ts": "export function shared() { return 1; }",
			"src/a/moduleA.ts": `import { shared } from "../shared.ts"; shared();`,
			"src/b/moduleB.ts": `import { shared } from "../shared.ts"; shared();`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		const finding = report.misplacedFiles.find((f) =>
			f.file.includes("shared.ts")
		);
		expect(finding).toBeUndefined();
	});

	it("does not flag test files", async () => {
		const dir = await makeProject({
			"src/utils.ts": "export function util() { return 1; }",
			"src/core/utils.test.ts": `import { util } from "../utils.ts"; util();`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		const finding = report.misplacedFiles.find(
			(f) => f.file.includes("utils.ts") && !f.file.includes("test")
		);
		// util in root src/ is only imported from a test → test files are excluded
		// so it may have 0 in-scope importers; not flagged
		expect(finding).toBeUndefined();
	});
});

describe("organise: basename collisions", () => {
	it("flags two files sharing a basename with divergent function signatures", async () => {
		const dir = await makeProject({
			"src/utils/merge.ts":
				"export function merge(a: string, b: string): string { return a + b; }",
			"src/helpers/merge.ts": `export function merge(items: string[]): string { return items.join(""); }`,
			"src/app.ts": `
				import { merge as m1 } from "./utils/merge.ts";
				import { merge as m2 } from "./helpers/merge.ts";
				m1("a", "b"); m2(["a"]);
			`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		const collision = report.basenameCollisions.find(
			(c) => c.basename === "merge"
		);
		expect(collision).toBeDefined();
		expect(collision?.files).toHaveLength(2);
		expect(collision?.conflictingExports).toHaveLength(1);
		const firstConflict = collision?.conflictingExports[0];
		expect(firstConflict).toBeDefined();
		expect(firstConflict?.name).toBe("merge");
	});

	it("does not flag two files sharing a basename with identical signatures", async () => {
		const dir = await makeProject({
			"src/utils/helper.ts":
				"export function helper(x: number): number { return x; }",
			"src/core/helper.ts":
				"export function helper(x: number): number { return x * 2; }",
			"src/app.ts": `
				import { helper as h1 } from "./utils/helper.ts";
				import { helper as h2 } from "./core/helper.ts";
				h1(1); h2(2);
			`,
		});
		const report = await buildOrganiseReport({ directory: dir });
		const collision = report.basenameCollisions.find(
			(c) => c.basename === "helper"
		);
		// Same signature — not a conflict
		expect(collision).toBeUndefined();
	});
});

describe("organise: --ignore option", () => {
	it("suppresses candidates matching the ignore glob", async () => {
		const dir = await makeProject({
			"src/helper.ts": "export function doWork() { return 42; }",
			"src/core/cookies/a.ts": `import { doWork } from "../../helper.ts"; doWork();`,
		});
		const reportFull = await buildOrganiseReport({ directory: dir });
		const reportIgnored = await buildOrganiseReport({
			directory: dir,
			ignore: "helper.ts",
		});
		// Full report should find the misplaced file
		expect(reportFull.summary.totalMisplaced).toBeGreaterThan(0);
		// Ignored report should not
		expect(reportIgnored.summary.totalMisplaced).toBe(0);
	});
});

describe("organise: CLI integration", () => {
	it("exits 0 and prints a summary for a clean project", async () => {
		const dir = await makeProject({
			"src/a.ts": "export function a() { return 1; }",
			"src/b.ts": `import { a } from "./a.ts"; a();`,
		});
		const { stdout } = await captureOutput(() =>
			organiseCommand({ directory: dir })
		);
		expect(`${stdout}`).toMatch(/No organisation issues|Scanned|misplaced/i);
	});

	it("emits valid JSON with --json", async () => {
		const dir = await makeProject({
			"src/a.ts": "export function a() { return 1; }",
		});
		const { stdout } = await captureOutput(() =>
			organiseCommand({ directory: dir, json: true })
		);
		const parsed = JSON.parse(stdout);
		expect(parsed.schemaVersion).toBe("1");
		expect(parsed.summary).toBeDefined();
	});
});
