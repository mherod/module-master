import { getRuntime } from "../runtime/index.ts";

/**
 * Read and parse a package.json file via the runtime fs.
 *
 * Returns the parsed object typed as `T` (defaults to a generic record),
 * or `null` when the file is missing or contains invalid JSON. Callers that
 * know the shape pass it explicitly, e.g.
 * `readPackageJson<PackageJsonEntrypoints>(path)`.
 */
export async function readPackageJson<T = Record<string, unknown>>(
	filePath: string
): Promise<T | null> {
	try {
		const content = await getRuntime().fs.readFile(filePath);
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}
