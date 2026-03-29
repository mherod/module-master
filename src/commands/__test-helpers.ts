import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

export interface FixtureOptions {
	/** When true, writes a default tsconfig.json unless one is provided in files */
	tsconfig?: boolean;
}

export async function makeFixture(
	prefix: string,
	files: Record<string, string>,
	options?: FixtureOptions
): Promise<string> {
	const dir = path.join(
		import.meta.dir,
		"__fixtures__",
		`${prefix}-${Date.now()}`
	);
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

export async function cleanup(dir: string) {
	await rm(dir, { recursive: true, force: true });
}
