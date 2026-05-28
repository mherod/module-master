import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "./__test-helpers.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "resect-move-"));
	tempDirs.push(dir);
	return dir;
}

async function expectGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	if (proc.exitCode !== 0 || stderr) {
		throw new Error(
			`git ${args.join(" ")} failed with ${proc.exitCode ?? 0}: ${stderr}`
		);
	}
	return stdout;
}

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("moveModule", () => {
	test("handles same-directory case-only renames and updates importers", async () => {
		const dir = await tempDir();
		const srcDir = path.join(dir, "src", "utils");
		await mkdir(srcDir, { recursive: true });
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify(
				{
					compilerOptions: {
						module: "ESNext",
						moduleResolution: "Bundler",
						noEmit: true,
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
		await writeFile(
			path.join(srcDir, "Foo.ts"),
			"export function bar() { return 1; }\n"
		);
		await writeFile(
			path.join(srcDir, "consumer.ts"),
			'import { bar } from "./Foo";\nexport const value = bar();\n'
		);
		await expectGit(dir, ["init"]);
		await expectGit(dir, ["config", "user.name", "Resect Test"]);
		await expectGit(dir, ["config", "user.email", "resect@example.invalid"]);
		await expectGit(dir, ["add", "."]);
		await expectGit(dir, ["commit", "-m", "initial"]);

		const source = path.join(srcDir, "Foo.ts");
		const target = path.join(srcDir, "foo.ts");
		const result = await runCli(["move", source, target, "--no-verify"]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(target).exists()).toBe(true);
		const renamedEntries = await readdir(srcDir);
		expect(renamedEntries).toContain("foo.ts");
		expect(renamedEntries).not.toContain("Foo.ts");
		const consumer = await readFile(path.join(srcDir, "consumer.ts"), "utf-8");
		expect(consumer).toContain('from "./foo"');

		await expectGit(dir, ["add", "-A"]);
		const status = await expectGit(dir, ["status", "--porcelain"]);
		expect(status).toContain("R");
		await expectGit(dir, ["commit", "-m", "case rename"]);
		const log = await expectGit(dir, [
			"log",
			"--follow",
			"--oneline",
			"--",
			"src/utils/foo.ts",
		]);
		expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);
	});
});
