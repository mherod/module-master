import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { applyChanges } from "./alias.ts";

let fixtureCounter = 0;
function nextDir(): string {
	fixtureCounter++;
	return path.join(
		import.meta.dir,
		"__fixtures__",
		`alias-${fixtureCounter}-${Date.now()}`
	);
}

afterEach(async () => {
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
