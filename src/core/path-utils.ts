import path from "node:path";

export interface TsconfigPathResult {
	tsconfigPath: string;
}

export function isWithinPath(baseDir: string, filePath: string): boolean {
	const relative = path.relative(baseDir, filePath);
	return (
		relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
	);
}

export function toRelativePath(baseDir: string, filePath: string): string {
	return path.relative(baseDir, filePath) || ".";
}

export function dedupeTsconfigResults<T extends TsconfigPathResult>(
	items: T[]
): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const item of items) {
		const key = path.resolve(item.tsconfigPath);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}
