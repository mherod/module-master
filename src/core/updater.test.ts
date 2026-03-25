import { describe, expect, test } from "bun:test";
import { generateBarrelExport } from "./updater.ts";

describe("generateBarrelExport", () => {
	test("strips modern TS/JS extensions from barrel export specifier", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = 'export * from "./existing";\n';

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/foo.mts",
			barrelPath
		);
		expect(exportStatement).toBe('export * from "./foo";\n');
	});

	test("strips .vue extension from barrel export specifier", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = "";

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/components/Thing.vue",
			barrelPath
		);
		expect(exportStatement).toBe('export * from "./components/Thing";\n');
	});
});
