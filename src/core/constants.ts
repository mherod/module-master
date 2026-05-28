/**
 * Shared constants and patterns for resect
 */

/** Pattern to match TypeScript/JavaScript file extensions */
export const TS_JS_EXTENSION_PATTERN = /\.[tj]sx?$/;

/** Pattern to match any file extension */
export const FILE_EXTENSION_PATTERN = /\.[^.]+$/;

/** Pattern to identify per-file TypeScript compiler error messages (file:line:col: error TS####). */
export const TSC_ERROR_PATTERN = ": error TS";

/**
 * Pattern for global tsc errors that have no source file context — these are
 * emitted before per-file checking can run, so a non-zero tsc exit accompanied
 * only by these lines means verification was incomplete, not that the project
 * has zero errors. Example: `error TS2688: Cannot find type definition file for 'jest'.`
 */
export const TSC_GLOBAL_ERROR_PATTERN = /^error TS\d+:/;

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
