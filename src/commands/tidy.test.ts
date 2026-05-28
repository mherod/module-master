import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`tidy-${name}`, files, { tsconfig: true });
}

const DUPLICATE_A = `
export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  const date = parts[0];
  return date;
}
`;

const DUPLICATE_B = `
export function formatTimestamp(value: Date): string {
  const str = value.toISOString();
  const segments = str.split("T");
  const result = segments[0];
  return result;
}
`;

const EXPORT_SURFACE = Array.from(
	{ length: 9 },
	(_, index) => `export const value${index} = ${index};`
).join("\n");

describe("tidy command", () => {
	test("requires the experimental flag", async () => {
		const dir = await makeFixture("gate", {
			"src/orphan.ts": "export function orphan() { return 1; }",
		});

		const proc = Bun.spawn([...CLI, "tidy", path.join(dir, "src")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("experimental");

		await cleanup(dir);
	});

	test("emits grouped human-readable report", async () => {
		const dir = await makeFixture("human", {
			"src/orphan.ts": "export function orphan() { return 1; }",
			"src/dup-a.ts": DUPLICATE_A,
			"src/dup-b.ts": DUPLICATE_B,
			"src/surface.ts": EXPORT_SURFACE,
		});

		const proc = Bun.spawn(
			[...CLI, "tidy", path.join(dir, "src"), "--experimental"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Unused exports");
		expect(stdout).toContain("Similar declarations");
		expect(stdout).toContain("Module health");

		await cleanup(dir);
	});

	test("json contains versioned grouped findings and summary", async () => {
		const dir = await makeFixture("json", {
			"src/orphan.ts": "export function orphan() { return 1; }",
			"src/dup-a.ts": DUPLICATE_A,
			"src/dup-b.ts": DUPLICATE_B,
			"src/surface.ts": EXPORT_SURFACE,
		});

		const proc = Bun.spawn(
			[...CLI, "tidy", path.join(dir, "src"), "--experimental", "--json"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.schemaVersion).toBe("1-experimental");
		expect(report.findings.unused.length).toBeGreaterThan(0);
		expect(report.findings.similar.length).toBeGreaterThan(0);
		expect(report.findings.audit.length).toBeGreaterThan(0);
		expect(report.summary.totalFindings).toBe(
			report.findings.unused.length +
				report.findings.similar.length +
				report.findings.audit.length
		);
		expect(report.summary.filesTouched).toBe(0);

		await cleanup(dir);
	});

	test("scope filters findings to the requested subtree", async () => {
		const dir = await makeFixture("scope", {
			"src/core/cookies/orphan.ts":
				"export function scopedOnly() { return 1; }",
			"src/other/orphan.ts": "export function outsideOnly() { return 2; }",
		});
		const scope = path.join(dir, "src/core/cookies");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--json",
				"--scope",
				scope,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.findings.unused.length).toBeGreaterThan(0);
		for (const finding of report.findings.unused as { sourceFile: string }[]) {
			expect(finding.sourceFile).toStartWith("core/cookies/");
		}

		await cleanup(dir);
	});

	test("--out writes the selected report format to disk", async () => {
		const dir = await makeFixture("out", {
			"src/orphan.ts": "export function orphan() { return 1; }",
		});
		const outPath = path.join(dir, "tidy-report.json");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--json",
				"--out",
				outPath,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(await readFile(outPath, "utf8"));
		expect(report.schemaVersion).toBe("1-experimental");

		await cleanup(dir);
	});
});
