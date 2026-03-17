/**
 * Shared constants and patterns for resect
 */

/** Pattern to match TypeScript/JavaScript file extensions */
export const TS_JS_EXTENSION_PATTERN = /\.[tj]sx?$/;

/** Pattern to match any file extension */
export const FILE_EXTENSION_PATTERN = /\.[^.]+$/;

/** Pattern to identify TypeScript compiler error messages */
export const TSC_ERROR_PATTERN = ": error TS";

/** Pattern to detect export statements in a file */
export const EXPORT_STATEMENT_PATTERN =
	/\bexport\s+(?:\*|{|(?:default|const|let|var|function|class|type|interface|enum)\b)/;

/** TypeScript/JavaScript file extensions for scanning */
export const TS_JS_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** Vue single-file component extension */
export const VUE_EXTENSION = /\.vue$/;

/** TypeScript, JavaScript, and Vue file extensions for scanning */
export const TS_JS_VUE_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|vue)$/;

/**
 * Remove TypeScript/JavaScript/Vue extension from a path
 */
export function removeExtension(filePath: string): string {
	return filePath.replace(TS_JS_VUE_EXTENSIONS, "");
}
