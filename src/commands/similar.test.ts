import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

async function makeFixture(
	name: string,
	files: Record<string, string>
): Promise<string> {
	const dir = path.join(
		import.meta.dir,
		"__fixtures__",
		`similar-${name}-${Date.now()}`
	);
	await mkdir(dir, { recursive: true });
	// Write tsconfig so discoverProject finds files
	await writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true },
			include: ["**/*.ts"],
		})
	);
	for (const [filePath, content] of Object.entries(files)) {
		const full = path.join(dir, filePath);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	return dir;
}

async function cleanup(dir: string) {
	await rm(dir, { recursive: true, force: true });
}

// Two files with identical functions (different variable names) to guarantee a group
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

describe("similar command", () => {
	test("reports no similar declarations for unique functions", async () => {
		const dir = await makeFixture("unique", {
			"a.ts": `
export function add(a: number, b: number): number {
  const sum = a + b;
  const doubled = sum * 2;
  return doubled;
}`,
			"b.ts": `
export function greet(name: string): string {
  const prefix = "Hello";
  const message = prefix + " " + name;
  return message;
}`,
		});

		const proc = Bun.spawn([...CLI, "similar", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("No similar declarations found");

		await cleanup(dir);
	});

	test("finds duplicate functions and reports groups", async () => {
		const dir = await makeFixture("dupes", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn([...CLI, "similar", dir, "--threshold=0.7"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("candidate group");
		expect(stdout).toContain("formatDate");
		expect(stdout).toContain("formatTimestamp");

		await cleanup(dir);
	});

	test("--json outputs valid JSON with group data", async () => {
		const dir = await makeFixture("json", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.totalFunctions).toBeGreaterThanOrEqual(2);
		expect(parsed.totalFiles).toBeGreaterThanOrEqual(2);
		expect(parsed.groups).toBeArray();
		expect(parsed.totalGroups).toBeNumber();
		expect(typeof parsed.truncated).toBe("boolean");

		await cleanup(dir);
	});

	test("--strict exits with error when groups found", async () => {
		const dir = await makeFixture("strict", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--strict", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("similar declaration group");

		await cleanup(dir);
	});

	test("--strict exits 0 when no groups found", async () => {
		const dir = await makeFixture("strict-clean", {
			"a.ts": `
export function unique(x: number): number {
  const doubled = x * 2;
  const shifted = doubled + 10;
  return shifted;
}`,
		});

		const proc = Bun.spawn([...CLI, "similar", dir, "--strict"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		await cleanup(dir);
	});

	test("--format=compact produces compact output", async () => {
		const dir = await makeFixture("compact", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--format=compact", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		// Compact format uses "---" prefix for groups
		if (stdout.includes("---")) {
			expect(stdout).toContain("formatDate");
		}

		await cleanup(dir);
	});

	test("--max-groups limits output", async () => {
		const dir = await makeFixture("maxgroups", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--threshold=0.7", "--max-groups=1"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.groups.length).toBeLessThanOrEqual(1);

		await cleanup(dir);
	});

	test("--json --strict exits 1 with error on stderr", async () => {
		const dir = await makeFixture("json-strict", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--strict", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		// JSON is still written to stdout
		expect(() => JSON.parse(stdout)).not.toThrow();
		// Error message on stderr
		expect(stderr).toContain("similar declaration group");

		await cleanup(dir);
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "similar"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("similar requires a <directory> argument");
	});
});
