import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

const CAMEL_NAMES = [
	"alphaOne",
	"betaTwo",
	"gammaThree",
	"deltaFour",
	"epsilonFive",
	"zetaSix",
	"etaSeven",
	"thetaEight",
	"iotaNine",
	"kappaTen",
] as const;

const PASCAL_FUNCTION_NAMES = [
	"BuildReport",
	"LoadAccount",
	"ParseConfig",
	"RenderPanel",
] as const;

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`naming-${name}`, files, { tsconfig: true });
}

function functionFile(name: string): string {
	return `export function ${name}() { return "${name}"; }\n`;
}

function classFile(name: string): string {
	return `export class ${name} { value = "${name}"; }\n`;
}

function withFiles(
	names: readonly string[],
	makeContent: (name: string) => string
) {
	const files: Record<string, string> = {};
	for (const name of names) {
		files[`src/group/${name}.ts`] = makeContent(name);
	}
	return files;
}

async function runCli(args: string[]): Promise<CliResult> {
	const proc = Bun.spawn([...CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode };
}

describe("naming command", () => {
	test("reports PascalCase function files in a camelCase-majority directory", async () => {
		const dir = await makeFixture("camel-majority", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await runCli(["naming", path.join(dir, "src"), "--json"]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.schemaVersion).toBe("1");
		expect(report.findings).toHaveLength(4);
		expect(report.summary.totalFindings).toBe(4);
		for (const finding of report.findings as Array<{
			currentCasing: string;
			suggestedName: string;
			primaryExportKind: string;
			siblingCasingMajority: string;
		}>) {
			expect(finding.currentCasing).toBe("PascalCase");
			expect(finding.primaryExportKind).toBe("function");
			expect(finding.siblingCasingMajority).toBe("camelCase");
			expect(finding.suggestedName).toStartWith(
				finding.suggestedName.charAt(0).toLowerCase()
			);
		}

		await cleanup(dir);
	});

	test("keeps PascalCase class files when the export kind justifies casing", async () => {
		const dir = await makeFixture("class-justified", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/AccountService.ts": classFile("AccountService"),
		});

		const result = await runCli(["naming", path.join(dir, "src"), "--json"]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("does not report when no directory casing has a majority", async () => {
		const dir = await makeFixture("no-majority", {
			...withFiles(CAMEL_NAMES.slice(0, 5), functionFile),
			...withFiles(
				[
					"BuildReport",
					"LoadAccount",
					"ParseConfig",
					"RenderPanel",
					"SyncStore",
				],
				functionFile
			),
		});

		const result = await runCli(["naming", path.join(dir, "src"), "--json"]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("honors --majority-threshold", async () => {
		const dir = await makeFixture("threshold", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await runCli([
			"naming",
			path.join(dir, "src"),
			"--json",
			"--majority-threshold",
			"0.8",
		]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("prints a grouped human-readable report", async () => {
		const dir = await makeFixture("human", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await runCli(["naming", path.join(dir, "src")]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Naming Report");
		expect(result.stdout).toContain("group");
		expect(result.stdout).toContain("BuildReport.ts -> buildReport.ts");

		await cleanup(dir);
	});

	test("--fix is gated until safe case-only renames land", async () => {
		const dir = await makeFixture("fix-gate", {
			"src/group/BuildReport.ts": functionFile("BuildReport"),
			"src/group/alphaOne.ts": functionFile("alphaOne"),
			"src/group/betaTwo.ts": functionFile("betaTwo"),
		});

		const result = await runCli([
			"naming",
			path.join(dir, "src"),
			"--fix",
			"--force",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("blocked on #72");

		await cleanup(dir);
	});

	test("registers the read-only MCP tool", async () => {
		const serverSource = await readFile(
			path.resolve(import.meta.dir, "../mcp-server.ts"),
			"utf8"
		);
		expect(serverSource).toContain('server.registerTool(\n\t"naming"');
		expect(serverSource).toContain("buildNamingReport");
	});
});
