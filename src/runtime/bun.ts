import { Glob } from "bun";
import type { FileSystem, GlobRunner, Runtime } from "./types.ts";

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

export const bunRuntime: Runtime = { fs: bunFs, glob: bunGlob };
