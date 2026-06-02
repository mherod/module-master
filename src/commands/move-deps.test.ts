import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveModule } from "./move.ts";

/**
 * End-to-end coverage for #118: a cross-package `move` must sync the moved
 * file's external dependencies into the destination package.json. Exercises the
 * scanner external-import seam (scanExternalImports) + the dependency-sync
 * write path through the real moveModule pipeline on a pnpm-workspace fixture.
 */

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`move-deps-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

const WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: { strict: true },
		include: ["packages/**/*.ts"],
	}),
	"packages/pkg-a/package.json": JSON.stringify({
		name: "@scope/pkg-a",
		dependencies: { lodash: "^4.17.21" },
	}),
	"packages/pkg-a/src/foo.ts": 'import _ from "lodash";\nexport const foo = _;',
	"packages/pkg-b/package.json": JSON.stringify({
		name: "@scope/pkg-b",
		dependencies: {},
	}),
	"packages/pkg-b/src/keep.ts": "export const keep = true;",
} as const;

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(filePath).text());
}

async function move(
	dir: string,
	source: string,
	target: string,
	dryRun = false
) {
	const absSource = path.join(dir, source);
	const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
	if (!tsconfigPath) {
		throw new Error("tsconfig not found");
	}
	const project = loadProject(tsconfigPath, absSource);
	const workspace = (await discoverWorkspace(dir)) ?? undefined;
	return moveModule(
		absSource,
		path.join(dir, target),
		project,
		dryRun,
		false,
		workspace
	);
}

describe("move cross-package dependency sync (#118)", () => {
	test("adds the moved file's external dep to the destination package.json", async () => {
		const dir = await fixture("external-added", { ...WORKSPACE });
		const result = await move(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(true);
		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "lodash",
				version: "^4.17.21",
				field: "dependencies",
			},
		]);

		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.17.21"
		);
	});

	test("is a no-op when the destination already declares the dep", async () => {
		const dir = await fixture("already-present", {
			...WORKSPACE,
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: { lodash: "^4.0.0" },
			}),
		});
		const result = await move(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.dependencyChanges).toEqual([]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		// Existing range is untouched (no downgrade/upgrade).
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.0.0"
		);
	});

	test("dry-run reports the proposed addition without writing", async () => {
		const dir = await fixture("dry-run", { ...WORKSPACE });
		const result = await move(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts",
			true
		);

		expect(result.dependencyChanges).toHaveLength(1);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		// Nothing written on dry-run.
		expect(destPkg.dependencies).toEqual({});
	});

	test("maps a subpath import (lodash/fp) back to its package name", async () => {
		const dir = await fixture("subpath", {
			...WORKSPACE,
			"packages/pkg-a/src/foo.ts":
				'import fp from "lodash/fp";\nexport const foo = fp;',
		});
		const result = await move(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "lodash",
				version: "^4.17.21",
				field: "dependencies",
			},
		]);
	});

	test("same-package move does not touch any package.json", async () => {
		const dir = await fixture("same-pkg", { ...WORKSPACE });
		const result = await move(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-a/src/bar.ts"
		);

		expect(result.dependencyChanges).toEqual([]);
	});
});
