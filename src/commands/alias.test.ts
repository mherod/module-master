import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import {
	aliasCommand,
	applyChanges,
	parseSpecifierRenames,
	renameImportSpecifiers,
} from "./alias.ts";

let fixtureCounter = 0;
function nextDir(): string {
	fixtureCounter++;
	return path.join(
		import.meta.dir,
		"__fixtures__",
		`alias-${fixtureCounter}-${Date.now()}`
	);
}

afterAll(async () => {
	const fixturesDir = path.join(import.meta.dir, "__fixtures__");
	try {
		const glob = new Bun.Glob("alias-*");
		for await (const match of glob.scan({
			cwd: fixturesDir,
			onlyFiles: false,
		})) {
			await rm(path.join(fixturesDir, match), {
				recursive: true,
				force: true,
			});
		}
	} catch {
		// Fixtures directory may not exist yet
	}
});

async function writeAliasProject(
	files: Record<string, string>
): Promise<{ dir: string; srcDir: string; projectPath: string }> {
	const dir = nextDir();
	const srcDir = path.join(dir, "src");
	await mkdir(srcDir, { recursive: true });
	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					baseUrl: ".",
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
					paths: {
						"@lib/*": ["src/lib/*"],
						"@utils/*": ["src/utils/*"],
					},
					strict: true,
					target: "ESNext",
					types: [],
				},
				include: ["src/**/*.ts"],
			},
			null,
			2
		)
	);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(dir, relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return {
		dir,
		srcDir,
		projectPath: path.join(dir, "tsconfig.json"),
	};
}

describe("applyChanges — AST-targeted specifier replacement", () => {
	test("rewrites import specifiers without modifying non-module strings", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "consumer.ts");
		const content = [
			'import { helper } from "./utils";',
			"",
			'const file = Bun.file("./utils");',
			'const url = "https://example.com/./utils";',
			'const config = { path: "./utils" };',
			"",
			"export function main() {",
			"  return helper();",
			"}",
		].join("\n");

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();

		// Import specifier should be updated
		expect(result).toContain('from "@/utils"');

		// Non-module strings must NOT be modified
		expect(result).toContain('Bun.file("./utils")');
		expect(result).toContain('"https://example.com/./utils"');
		expect(result).toContain('path: "./utils"');
	});

	test("rewrites export specifiers", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "barrel.ts");
		const content = 'export { helper } from "./utils";\n';

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('from "@/utils"');
	});

	test("rewrites dynamic import specifiers", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "dynamic.ts");
		const content = 'const mod = await import("./utils");\n';

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('import("@/utils")');
	});
});

describe("renameImportSpecifiers", () => {
	test("rewrites exact specifiers across aliased, type-only, and namespace imports", async () => {
		const { srcDir } = await writeAliasProject({
			"src/utils/foo.ts": [
				"export const foo = 1;",
				"export const bar = 2;",
				"export type Q = { value: number };",
			].join("\n"),
			"src/one.ts": 'import { foo, bar as baz } from "@utils/Foo";\n',
			"src/two.ts": 'import type { Q } from "@utils/Foo";\n',
			"src/three.ts": 'import * as F from "@utils/Foo";\n',
		});

		await aliasCommand({
			target: srcDir,
			renameSpecifiers: ["@utils/Foo=@utils/foo"],
			force: true,
			verify: false,
		});

		const one = await Bun.file(path.join(srcDir, "one.ts")).text();
		const two = await Bun.file(path.join(srcDir, "two.ts")).text();
		const three = await Bun.file(path.join(srcDir, "three.ts")).text();

		expect(one).toContain('from "@utils/foo"');
		expect(one).toContain("bar as baz");
		expect(two).toContain('import type { Q } from "@utils/foo"');
		expect(three).toContain('import * as F from "@utils/foo"');
		expect(`${one}\n${two}\n${three}`).not.toContain("@utils/Foo");
	});

	test("supports multiple rename-specifier flags in one result", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const foo = 1;\n",
			"src/lib/new.ts": "export const old = 1;\n",
			"src/one.ts": 'import { foo } from "@utils/Foo";\n',
			"src/two.ts": 'import { old } from "@lib/Old";\n',
		});
		const project = loadProject(projectPath);
		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@utils/Foo=@utils/foo", "@lib/Old=@lib/new"]),
			project
		);

		expect(result.conflicts).toHaveLength(0);
		expect(result.changes).toHaveLength(2);
		expect(result.changes.map((change) => change.newSpecifier).sort()).toEqual([
			"@lib/new",
			"@utils/foo",
		]);
	});

	test("dry-run does not write files", async () => {
		const { srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const foo = 1;\n",
			"src/one.ts": 'import { foo } from "@utils/Foo";\n',
		});

		await aliasCommand({
			target: srcDir,
			renameSpecifiers: ["@utils/Foo=@utils/foo"],
			dryRun: true,
			verify: false,
		});

		const result = await Bun.file(path.join(srcDir, "one.ts")).text();
		expect(result).toContain('from "@utils/Foo"');
	});

	test("reports conflicts when the target specifier already exists in a file", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const bar = 1;\nexport const baz = 2;\n",
			"src/conflict.ts": [
				'import { bar } from "@utils/foo";',
				'import { baz } from "@utils/Foo";',
			].join("\n"),
		});
		const project = loadProject(projectPath);
		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@utils/Foo=@utils/foo"]),
			project
		);

		expect(result.changes).toHaveLength(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.oldSpecifier).toBe("@utils/Foo");
		expect(result.conflicts[0]?.newSpecifier).toBe("@utils/foo");
	});
});
