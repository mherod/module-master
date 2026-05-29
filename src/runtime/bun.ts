import { Glob } from "bun";
import type {
	FileSystem,
	GlobRunner,
	ProcessRunner,
	Runtime,
} from "./types.ts";

const bunFs: FileSystem = {
	async readFile(path: string): Promise<string> {
		return Bun.file(path).text();
	},

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await Bun.write(path, content);
	},

	async exists(path: string): Promise<boolean> {
		const f = Bun.file(path);
		if (await f.exists()) {
			return true;
		}
		// Bun.file().exists() returns false for directories; fall back to stat
		try {
			const { stat } = await import("node:fs/promises");
			await stat(path);
			return true;
		} catch {
			return false;
		}
	},

	async deleteFile(path: string): Promise<void> {
		await Bun.file(path).delete();
	},

	async rename(from: string, to: string): Promise<void> {
		const { rename } = await import("node:fs/promises");
		await rename(from, to);
	},
};

const bunGlob: GlobRunner = {
	glob(
		pattern: string,
		{ cwd, absolute }: { cwd: string; absolute?: boolean }
	): AsyncIterable<string> {
		const g = new Glob(pattern);
		return g.scan({ cwd, absolute });
	},
};

const bunProcess: ProcessRunner = {
	async exec(command, options) {
		const proc = Bun.spawn(command, {
			cwd: options?.cwd,
			stdin: options?.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (options?.stdin !== undefined && proc.stdin) {
			proc.stdin.write(options.stdin);
			await proc.stdin.end();
		}
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		return { stdout, stderr, exitCode: proc.exitCode };
	},
};

export const bunRuntime: Runtime = {
	fs: bunFs,
	glob: bunGlob,
	process: bunProcess,
};
