/**
 * Shared constants and patterns for module-master
 */

/** Pattern to match TypeScript/JavaScript file extensions */
export const TS_JS_EXTENSION_PATTERN = /\.[tj]sx?$/;

/** Pattern to match any file extension */
export const FILE_EXTENSION_PATTERN = /\.[^.]+$/;

/** Pattern to identify TypeScript compiler error messages */
export const TSC_ERROR_PATTERN = ": error TS";

/** Pattern to detect export statements in a file */
export const EXPORT_STATEMENT_PATTERN =
	/\bexport\s+(\*|{|default|const|let|var|function|class|type|interface|enum)\b/;

/** TypeScript/JavaScript file extensions for scanning */
export const TS_JS_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/**
 * Remove TypeScript/JavaScript extension from a path
 */
export function removeExtension(filePath: string): string {
	return filePath.replace(TS_JS_EXTENSION_PATTERN, "");
}
