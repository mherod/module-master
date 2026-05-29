import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverProject } from "./tsconfig-discovery";

describe("discoverProject cache", () => {
	test("rebuilds discovery when a tsconfig's content changes (same tsconfig set)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-content-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			await writeFile(path.join(srcDir, "a.ts"), "export const a = 1;\n");
			await writeFile(path.join(srcDir, "b.ts"), "export const b = 2;\n");
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);

			const first = discoverProject(dir);
			const firstRoot = first.configs.find((c) =>
				c.path.endsWith("tsconfig.json")
			);
			expect(firstRoot).toBeDefined();
			// include matches both a.ts and b.ts
			expect(firstRoot?.files.length ?? 0).toBe(2);

			// Narrow include to just a.ts — same tsconfig file, edited content.
			// Force a distinctly-later mtime so staleness is detectable on any
			// filesystem regardless of mtime resolution.
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/a.ts"],
				})
			);
			const future = new Date(Date.now() + 10_000);
			await utimes(tsconfigPath, future, future);

			const second = discoverProject(dir);
			const secondRoot = second.configs.find((c) =>
				c.path.endsWith("tsconfig.json")
			);
			// A stale cache would still report 2 files from the original include.
			expect(secondRoot?.files.length ?? 0).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
