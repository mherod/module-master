import path from "node:path";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[tj]sx?|vue)$/;

export function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERN.test(path.basename(filePath));
}
