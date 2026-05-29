import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

interface FixtureOptions {
	/** When true, writes a default tsconfig.json unless one is provided in files */
	tsconfig?: boolean;
	/** Put generated fixtures outside the repo when files use *.test.* names */
	outsideRepo?: boolean;
}

export async function makeFixture(
	prefix: string,
	files: Record<string, string>,
	options?: FixtureOptions
): Promise<string> {
	const fixtureRoot = options?.outsideRepo
		? path.join(tmpdir(), "resect-fixtures")
		: path.join(import.meta.dir, "__fixtures__");
	const dir = path.join(fixtureRoot, `${prefix}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	if (options?.tsconfig && !files["tsconfig.json"]) {
		await writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["**/*.ts"],
			})
		);
	}
	for (const [filePath, content] of Object.entries(files)) {
		const full = path.join(dir, filePath);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	return dir;
}

/**
 * Create a uniquely-named throwaway temp directory under the OS tmpdir,
 * named `resect-<prefix>-XXXXXX`. The caller owns cleanup (track the returned
 * path and `rm` it in an afterAll). Shared by tests needing a real on-disk
 * working directory outside the repo (e.g. move, filesystem-case).
 */
export async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `resect-${prefix}-`));
	return dir;
}

export async function cleanup(dir: string) {
	await rm(dir, { recursive: true, force: true });
}

export async function runCli(args: string[]): Promise<CliResult> {
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
