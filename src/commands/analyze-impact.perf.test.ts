import { afterAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { analyzeImpact } from "./analyze-impact.ts";

const created: string[] = [];
afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

/** Recursively count files under a directory (read-only verification). */
async function countFiles(dir: string): Promise<number> {
	const entries = await readdir(dir, { withFileTypes: true });
	let total = 0;
	for (const entry of entries) {
		total += entry.isDirectory()
			? await countFiles(path.join(dir, entry.name))
			: 1;
	}
	return total;
}

describe("analyze-impact perf budget (#117)", () => {
	test("analyses a 1,000+ file project under 1.5s without writing", async () => {
		const MODULE_COUNT = 1000;
		const IMPORTER_COUNT = 100;
		const files: Record<string, string> = {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["**/*.ts"],
			}),
			"hub.ts": "export const hub = 1;",
		};
		for (let i = 0; i < MODULE_COUNT; i++) {
			files[`mod${i}.ts`] = `export const v${i} = ${i};`;
		}
		for (let i = 0; i < IMPORTER_COUNT; i++) {
			files[`imp${i}.ts`] =
				`import { hub } from "./hub";\nexport const u${i} = hub;`;
		}

		const dir = await makeFixture("analyze-impact-perf", files);
		created.push(dir);
		const source = path.join(dir, "hub.ts");
		const filesBefore = await countFiles(dir);

		const start = performance.now();
		const report = await analyzeImpact({
			source,
			target: path.join(dir, "hub-moved.ts"),
			project: dir,
		});
		const elapsedMs = performance.now() - start;

		// hub is imported by every imp*.ts importer.
		expect(report.impactedFilesCount).toBe(IMPORTER_COUNT);
		// Budget: well under 1.5s on a 1,100+ file fixture.
		expect(elapsedMs).toBeLessThan(1500);
		// Read-only: analysis must not create or remove any file.
		expect(await countFiles(dir)).toBe(filesBefore);
	}, 20_000);
});
