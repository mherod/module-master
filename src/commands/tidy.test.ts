import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`tidy-${name}`, files, { tsconfig: true });
}

async function makeGitFixture(name: string, files: Record<string, string>) {
	const dir = await makeFixtureBase(`tidy-${name}`, files, {
		tsconfig: true,
		outsideRepo: true,
	});
	await gitCommand(dir, ["init", "-b", "main"]);
	await gitCommand(dir, ["config", "user.email", "resect-test"]);
	await gitCommand(dir, ["config", "user.name", "Test User"]);
	await gitCommand(dir, ["add", "."]);
	await gitCommand(dir, ["commit", "-m", "initial"]);
	return dir;
}

async function gitCommand(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
	}
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

	test("--fix de-exports internally used unused exports", async () => {
		const dir = await makeGitFixture("fix-de-export", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "dead-exports",
				file: "util.ts",
				mutationKind: "de-export",
				target: "helper",
				wasRolledBack: false,
			})
		);
		expect(report.summary.filesTouched).toBe(1);
		expect(report.typecheckDelta).toEqual(
			expect.objectContaining({
				errorsAfter: 0,
				verificationIncomplete: false,
			})
		);
		const content = await readFile(path.join(dir, "src/util.ts"), "utf8");
		expect(content).toContain("function helper()");
		expect(content).not.toContain("export function helper()");
		expect(content).toContain("export function usedInternal()");

		await cleanup(dir);
	});

	test("--fix refuses a dirty worktree without force", async () => {
		const dir = await makeGitFixture("dirty-refusal", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const file = path.join(dir, "src/util.ts");
		await writeFile(
			file,
			`${await readFile(file, "utf8")}\nconst dirty = true;\n`
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("working tree has uncommitted changes");
		expect(await readFile(file, "utf8")).toContain("export function helper()");

		await cleanup(dir);
	});

	test("--force bypasses dirty worktree guard and disables rollback warning", async () => {
		const dir = await makeGitFixture("force-dirty", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
			"src/dirty.ts": "export const dirty = true;\n",
		});
		await writeFile(
			path.join(dir, "src/dirty.ts"),
			"export const dirty = false;\n"
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--force",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stderr).toContain("rollback is disabled");
		const report = JSON.parse(stdout);
		expect(report.summary.filesTouched).toBe(1);
		const content = await readFile(path.join(dir, "src/util.ts"), "utf8");
		expect(content).not.toContain("export function helper()");

		await cleanup(dir);
	});

	test("--max-changes aborts before writing", async () => {
		const dir = await makeGitFixture("max-changes", {
			"src/util.ts": `
export function helperA() {
	return 1;
}

export function helperB() {
	return 2;
}

export function usedInternal() {
	return helperA() + helperB();
}
`,
		});
		const file = path.join(dir, "src/util.ts");
		const before = await readFile(file, "utf8");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=dead-exports",
				"--max-changes",
				"1",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("exceeds --max-changes 1");
		const report = JSON.parse(stdout);
		expect(report.applied).toHaveLength(0);
		expect(await readFile(file, "utf8")).toBe(before);

		await cleanup(dir);
	});

	test("--fix rolls back when closing typecheck introduces an error", async () => {
		const dir = await makeGitFixture("rollback", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					module: "esnext",
					target: "es2022",
					strict: true,
				},
				include: ["**/*.ts"],
			}),
			"src/util.ts": `
export function loop(): number {
	return loop();
}

await Promise.resolve();
`,
		});
		const file = path.join(dir, "src/util.ts");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("tidy rolled back");
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				target: "loop",
				wasRolledBack: true,
			})
		);
		expect(report.typecheckDelta.newErrors.length).toBeGreaterThan(0);
		expect(await readFile(file, "utf8")).toContain("export function loop");

		await cleanup(dir);
	});

	test("--fix rolls back when typecheck verification is incomplete", async () => {
		const dir = await makeGitFixture("rollback-incomplete", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const file = path.join(dir, "src/util.ts");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("type checking did not complete");
		const report = JSON.parse(stdout);
		expect(report.typecheckDelta.verificationIncomplete).toBe(true);
		expect(report.typecheckDelta.incompleteReason.length).toBeGreaterThan(0);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				target: "helper",
				wasRolledBack: true,
			})
		);
		expect(await readFile(file, "utf8")).toContain("export function helper");

		await cleanup(dir);
	});
});
