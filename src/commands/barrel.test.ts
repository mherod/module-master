import { describe, expect, test } from "bun:test";
import type { BarrelScan } from "../types/barrel.ts";
import { type BarrelReportContext, buildBarrelReport } from "./barrel.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeContext(
	overrides: Partial<BarrelReportContext> = {}
): BarrelReportContext {
	return {
		barrelFiles: new Set<string>(),
		consumersOf: () => 1,
		subpathExportOf: () => null,
		...overrides,
	};
}

// ─── buildBarrelReport ───────────────────────────────────────────────────────

describe("buildBarrelReport", () => {
	test("counts entry kinds and source modules per barrel", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [
					{ type: "all", from: "./a" },
					{ type: "named", name: "x", from: "./b" },
					{ type: "named", name: "y", from: "./b" },
					{ type: "all-as", name: "ns", from: "./c" },
				],
				reExportedFiles: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());

		expect(report.totalBarrels).toBe(1);
		const info = report.barrels[0];
		expect(info?.totalEntries).toBe(4);
		expect(info?.sourceModules).toBe(3);
		expect(info?.wildcardCount).toBe(1);
		expect(info?.namedCount).toBe(2);
		expect(info?.namespaceCount).toBe(1);
	});

	test("flags barrels with wildcard re-exports", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/named.ts",
				entries: [{ type: "named", name: "x", from: "./b" }],
				reExportedFiles: ["/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());

		expect(report.wildcardBarrels.map((b) => b.barrel)).toEqual([
			"/repo/src/index.ts",
		]);
	});

	test("detects barrel chains (barrels re-exporting other barrels)", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./feature" }],
				reExportedFiles: ["/repo/src/feature/index.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				barrelFiles: new Set(["/repo/src/feature/index.ts"]),
			})
		);

		expect(report.chainedBarrels).toHaveLength(1);
		expect(report.chainedBarrels[0]?.reExportsBarrels).toEqual([
			"/repo/src/feature/index.ts",
		]);
	});

	test("flags unused barrels (no importers)", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/used.ts",
				entries: [{ type: "named", name: "x", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/orphan.ts",
				entries: [{ type: "named", name: "y", from: "./b" }],
				reExportedFiles: ["/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				consumersOf: (file) => (file === "/repo/src/orphan.ts" ? 0 : 3),
			})
		);

		expect(report.unusedBarrels.map((b) => b.barrel)).toEqual([
			"/repo/src/orphan.ts",
		]);
	});

	test("reports sub-path export shadowing (#93) and dedupes per barrel+file", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/packages/utils/src/index.ts",
				entries: [
					{ type: "all", from: "./cn" },
					{ type: "all", from: "./cn" },
				],
				reExportedFiles: ["/repo/packages/utils/src/cn.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				subpathExportOf: (file) =>
					file === "/repo/packages/utils/src/cn.ts"
						? { packageName: "@scope/utils", specifier: "@scope/utils/cn" }
						: null,
			})
		);

		expect(report.subpathShadowing).toHaveLength(1);
		expect(report.subpathShadowing[0]).toEqual({
			barrel: "/repo/packages/utils/src/index.ts",
			file: "/repo/packages/utils/src/cn.ts",
			packageName: "@scope/utils",
			specifier: "@scope/utils/cn",
		});
	});

	test("no shadowing when no dedicated sub-path export exists", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());
		expect(report.subpathShadowing).toEqual([]);
	});

	test("sorts barrels by total entries descending", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/small.ts",
				entries: [{ type: "named", name: "x", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/big.ts",
				entries: [
					{ type: "named", name: "x", from: "./a" },
					{ type: "named", name: "y", from: "./b" },
				],
				reExportedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());
		expect(report.barrels.map((b) => b.barrel)).toEqual([
			"/repo/src/big.ts",
			"/repo/src/small.ts",
		]);
	});
});
