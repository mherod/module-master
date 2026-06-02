import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { analyzeImpact } from "./analyze-impact.ts";

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`analyze-impact-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true },
	include: ["**/*.ts"],
});

describe("analyze-impact engine (#115)", () => {
	test("counts direct and indirect (barrel-chain) importers", async () => {
		const dir = await fixture("importers", {
			"tsconfig.json": TSCONFIG,
			"utils/foo.ts": "export const foo = 1;",
			"a.ts": 'import { foo } from "./utils/foo";\nconsole.log(foo);',
			"index.ts": 'export * from "./utils/foo";',
			"b.ts": 'import { foo } from "./index";\nconsole.log(foo);',
		});

		const report = await analyzeImpact({
			source: path.join(dir, "utils/foo.ts"),
			target: path.join(dir, "utils/foo2.ts"),
			project: dir,
		});

		// a.ts imports directly; index.ts re-exports (barrel); b.ts imports via the barrel (indirect).
		expect(report.impactedFiles).toContain("a.ts");
		expect(report.impactedFiles).toContain("index.ts");
		expect(report.impactedFiles).toContain("b.ts");
		expect(report.impactedFilesCount).toBe(report.impactedFiles.length);
		expect(report.impactedFilesCount).toBeGreaterThanOrEqual(3);
		// Single-package repo → no boundary, no missing deps.
		expect(report.boundaryCrossedCount).toBe(0);
		expect(report.missingDependencies).toEqual([]);
	});

	const WORKSPACE = {
		"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true },
			include: ["packages/**/*.ts"],
		}),
		"packages/pkg-a/package.json": JSON.stringify({
			name: "@scope/pkg-a",
			dependencies: { lodash: "^4.0.0" },
		}),
		"packages/pkg-a/src/foo.ts":
			'import _ from "lodash";\nexport const foo = _;',
		"packages/pkg-b/package.json": JSON.stringify({
			name: "@scope/pkg-b",
			dependencies: {},
		}),
		"packages/pkg-b/src/keep.ts": "export const keep = true;",
	} as const;

	test("flags a crossed package boundary and target-absent external deps", async () => {
		const dir = await fixture("cross-pkg", { ...WORKSPACE });

		const report = await analyzeImpact({
			source: path.join(dir, "packages/pkg-a/src/foo.ts"),
			target: path.join(dir, "packages/pkg-b/src/foo.ts"),
			project: dir,
		});

		expect(report.boundaryCrossedCount).toBe(1);
		expect(report.sourcePackage).toBe("@scope/pkg-a");
		expect(report.targetPackage).toBe("@scope/pkg-b");
		// pkg-b does not declare lodash → it is a missing dependency for the move.
		expect(report.missingDependencies).toEqual(["lodash"]);
	});

	test("reports no missing deps when the target package already declares them", async () => {
		const dir = await fixture("dep-present", {
			...WORKSPACE,
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: { lodash: "^4.0.0" },
			}),
		});

		const report = await analyzeImpact({
			source: path.join(dir, "packages/pkg-a/src/foo.ts"),
			target: path.join(dir, "packages/pkg-b/src/foo.ts"),
			project: dir,
		});

		expect(report.boundaryCrossedCount).toBe(1);
		expect(report.missingDependencies).toEqual([]);
	});

	test("no boundary crossing or missing deps for a same-package move", async () => {
		const dir = await fixture("same-pkg", { ...WORKSPACE });

		const report = await analyzeImpact({
			source: path.join(dir, "packages/pkg-a/src/foo.ts"),
			target: path.join(dir, "packages/pkg-a/src/bar.ts"),
			project: dir,
		});

		expect(report.boundaryCrossedCount).toBe(0);
		expect(report.sourcePackage).toBe("@scope/pkg-a");
		expect(report.targetPackage).toBe("@scope/pkg-a");
		expect(report.missingDependencies).toEqual([]);
	});

	test("scores breakingRisk 'low' for an unimported leaf module", async () => {
		const dir = await fixture("risk-low", {
			"tsconfig.json": TSCONFIG,
			"leaf.ts": "export const leaf = 1;",
		});

		const report = await analyzeImpact({
			source: path.join(dir, "leaf.ts"),
			target: path.join(dir, "leaf2.ts"),
			project: dir,
		});

		expect(report.impactedFilesCount).toBe(0);
		expect(report.breakingRisk).toBe("low");
	});

	test("scores breakingRisk 'high' when the target package is missing deps", async () => {
		const dir = await fixture("risk-high", { ...WORKSPACE });

		const report = await analyzeImpact({
			source: path.join(dir, "packages/pkg-a/src/foo.ts"),
			target: path.join(dir, "packages/pkg-b/src/foo.ts"),
			project: dir,
		});

		// Cross-package move with a missing dependency (lodash) → guaranteed break.
		expect(report.missingDependencies).toEqual(["lodash"]);
		expect(report.breakingRisk).toBe("high");
	});

	test("scores breakingRisk 'medium' for a stable, imported module within one package", async () => {
		const dir = await fixture("risk-medium", {
			"tsconfig.json": TSCONFIG,
			"util.ts": "export const util = 1;",
			"a.ts": 'import { util } from "./util";\nexport const a = util;',
		});

		const report = await analyzeImpact({
			source: path.join(dir, "util.ts"),
			target: path.join(dir, "renamed.ts"),
			project: dir,
		});

		// util.ts has an importer and zero imports → instability 0 (stable) → medium.
		expect(report.impactedFilesCount).toBeGreaterThanOrEqual(1);
		expect(report.boundaryCrossedCount).toBe(0);
		expect(report.breakingRisk).toBe("medium");
	});

	test("is read-only — the source file is never modified", async () => {
		const original = "export const foo = 1;\n";
		const dir = await fixture("read-only", {
			"tsconfig.json": TSCONFIG,
			"utils/foo.ts": original,
			"a.ts": 'import { foo } from "./utils/foo";\nconsole.log(foo);',
		});
		const sourcePath = path.join(dir, "utils/foo.ts");

		await analyzeImpact({
			source: sourcePath,
			target: path.join(dir, "utils/foo2.ts"),
			project: dir,
		});

		expect(await Bun.file(sourcePath).text()).toBe(original);
	});
});
