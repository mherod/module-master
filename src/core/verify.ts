import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ProjectConfig } from "../types.ts";
import { TSC_ERROR_PATTERN } from "./constants.ts";

export interface VerificationResult {
	success: boolean;
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	fixedErrors: string[];
}

/**
 * Verify type checking before and after changes
 */
export async function verifyTypeChecking(
	project: ProjectConfig,
	beforeSnapshot: () => void,
	applyChanges: () => void
): Promise<VerificationResult> {
	// Run type check before changes
	const errorsBefore = runTypeCheck(project);

	// Take snapshot if provided
	beforeSnapshot();

	// Apply the changes
	applyChanges();

	// Run type check after changes
	const errorsAfter = runTypeCheck(project);

	// Compare errors
	const newErrors = errorsAfter.filter((err) => !errorsBefore.includes(err));
	const fixedErrors = errorsBefore.filter((err) => !errorsAfter.includes(err));

	const success = newErrors.length === 0;

	return {
		success,
		errorsBefore,
		errorsAfter,
		newErrors,
		fixedErrors,
	};
}

/**
 * Run TypeScript compiler in noEmit mode and capture errors
 */
function runTypeCheck(project: ProjectConfig): string[] {
	const tsconfigPath = project.tsconfigPath;
	const cwd = path.dirname(tsconfigPath);

	// Run tsc --noEmit -p <tsconfig>
	const result = spawnSync(
		"tsc",
		["--noEmit", "-p", tsconfigPath, "--pretty", "false"],
		{
			cwd,
			encoding: "utf-8",
			shell: false,
		}
	);

	if (result.status === 0) {
		// No errors
		return [];
	}

	// Parse errors from stdout/stderr
	const output = (result.stdout + result.stderr).trim();
	if (!output) {
		return [];
	}

	// Split by lines and filter out empty lines
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	// Group errors by file
	const errors: string[] = [];
	for (const line of lines) {
		// TypeScript error format: path/to/file.ts(line,col): error TS####: message
		if (line.includes(TSC_ERROR_PATTERN)) {
			errors.push(line);
		}
	}

	return errors;
}

/**
 * Simple verification that just checks if tsc passes
 */
export function canTypeCheck(project: ProjectConfig): boolean {
	const errors = runTypeCheck(project);
	return errors.length === 0;
}

/**
 * Print verification results
 */
export function printVerificationResults(result: VerificationResult): void {
	if (result.success) {
		console.log("✅ Type checking passed - no new errors introduced");

		if (result.fixedErrors.length > 0) {
			console.log(`\n🎉 Fixed ${result.fixedErrors.length} existing error(s):`);
			for (const error of result.fixedErrors.slice(0, 5)) {
				console.log(`   ${error}`);
			}
			if (result.fixedErrors.length > 5) {
				console.log(`   ... and ${result.fixedErrors.length - 5} more`);
			}
		}
	} else {
		console.error(
			`\n❌ Type checking failed - ${result.newErrors.length} new error(s) introduced:`
		);
		for (const error of result.newErrors.slice(0, 10)) {
			console.error(`   ${error}`);
		}
		if (result.newErrors.length > 10) {
			console.error(`   ... and ${result.newErrors.length - 10} more`);
		}
	}

	console.log(
		`\nType errors: ${result.errorsAfter.length} total (${result.errorsBefore.length} before, ${result.newErrors.length} new, ${result.fixedErrors.length} fixed)`
	);
}
