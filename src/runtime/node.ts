import fs from "node:fs/promises";
import path from "node:path";
import type { FileSystem, GlobRunner, Runtime } from "./types.ts";

const nodeFs: FileSystem = {
	async readFile(filePath: string): Promise<string> {
		return fs.readFile(filePath, "utf-8");
	},

	async writeFile(
		filePath: string,
		content: string | Uint8Array
	): Promise<void> {
		await fs.writeFile(filePath, content);
	},

	async exists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	},

	async deleteFile(filePath: string): Promise<void> {
		await fs.unlink(filePath);
	},
};

async function* globScan(
	pattern: string,
	{ cwd, absolute = false }: { cwd: string; absolute?: boolean }
): AsyncGenerator<string> {
	const parts = pattern.split("/");
	yield* matchSegments(cwd, parts, 0, cwd, absolute);
}

async function* matchSegments(
	basePath: string,
	parts: string[],
	depth: number,
	cwd: string,
	absolute: boolean
): AsyncGenerator<string> {
	const part = parts[depth];
	if (part === undefined) {
		return;
	}
	const isLast = depth === parts.length - 1;

	if (part === "**") {
		// Match zero or more segments
		yield* matchSegments(basePath, parts, depth + 1, cwd, absolute);
		try {
			const entries = await fs.readdir(basePath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const nextPath = path.join(basePath, entry.name);
					yield* matchSegments(nextPath, parts, depth, cwd, absolute);
				}
			}
		} catch {
			// Directory not readable; skip
		}
	} else if (part.includes("*")) {
		const regex = new RegExp(`^${part.replace(/\*/g, "[^/]*")}$`);
		try {
			const entries = await fs.readdir(basePath, { withFileTypes: true });
			for (const entry of entries) {
				if (!regex.test(entry.name)) {
					continue;
				}
				const nextPath = path.join(basePath, entry.name);
				if (isLast) {
					yield absolute ? nextPath : path.relative(cwd, nextPath);
				} else if (entry.isDirectory()) {
					yield* matchSegments(nextPath, parts, depth + 1, cwd, absolute);
				}
			}
		} catch {
			// Directory not readable; skip
		}
	} else {
		const nextPath = path.join(basePath, part);
		if (isLast) {
			try {
				await fs.access(nextPath);
				yield absolute ? nextPath : path.relative(cwd, nextPath);
			} catch {
				// File not found; skip
			}
		} else {
			yield* matchSegments(nextPath, parts, depth + 1, cwd, absolute);
		}
	}
}

const nodeGlob: GlobRunner = {
	glob(
		pattern: string,
		options: { cwd: string; absolute?: boolean }
	): AsyncIterable<string> {
		return globScan(pattern, options);
	},
};

export const nodeRuntime: Runtime = { fs: nodeFs, glob: nodeGlob };
