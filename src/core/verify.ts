import path from "node:path";
import { logger } from "../cli-logger.ts";
import type { ProjectConfig } from "../types.ts";
import { TSC_ERROR_PATTERN } from "./constants.ts";
import { createProgram } from "./project.ts";
import { scanUnresolvableImports } from "./scanner.ts";

export interface UnresolvableDiagnosticWithFile {
	file: string;
	specifier: string;
	line: number;
	diagnostic: string;
}

/**
 * Collect all unresolvable imports across every project file.
 * Returns structured diagnostics with file path, specifier, line, and message.
 */
export function collectUnresolvableDiagnostics(
	project: ProjectConfig
): UnresolvableDiagnosticWithFile[] {
	const program = createProgram(project);
	const diagnostics: UnresolvableDiagnosticWithFile[] = [];
	for (const file of project.files) {
		const sf = program.getSourceFile(file);
		if (sf) {
			for (const diag of scanUnresolvableImports(sf, project)) {
				diagnostics.push({ file, ...diag });
			}
		}
	}
	return diagnostics;
}

export interface VerificationResult {
	success: boolean;
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	fixedErrors: string[];
	/** Unresolvable imports detected after changes, with file paths and specifiers */
	unresolvableDiagnostics?: UnresolvableDiagnosticWithFile[];
}

/**
 * Verify type checking before and after changes
 */
export async function verifyTypeChecking(
	project: ProjectConfig,
	beforeSnapshot: () => void,
	applyChanges: () => Promise<void> | void
): Promise<VerificationResult> {
	// Run type check before changes
	const errorsBefore = await runTypeCheck(project);

	// Take snapshot if provided
	beforeSnapshot();

	// Apply the changes
	await applyChanges();

	// Run type check after changes
	const errorsAfter = await runTypeCheck(project);

	// Collect unresolvable imports after changes are applied
	const unresolvableDiagnostics = collectUnresolvableDiagnostics(project);

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
		unresolvableDiagnostics,
	};
}

/**
 * Run TypeScript compiler in noEmit mode and capture errors
 */
export async function runTypeCheck(project: ProjectConfig): Promise<string[]> {
	const tsconfigPath = project.tsconfigPath;
	const cwd = path.dirname(tsconfigPath);

	// Run tsc --noEmit -p <tsconfig>
	const proc = Bun.spawn(
		["tsc", "--noEmit", "-p", tsconfigPath, "--pretty", "false"],
		{ cwd, stdout: "pipe", stderr: "pipe" }
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;

	if (proc.exitCode === 0) {
		return [];
	}

	// Parse errors from stdout/stderr
	const output = (stdout + stderr).trim();
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
export async function canTypeCheck(project: ProjectConfig): Promise<boolean> {
	const errors = await runTypeCheck(project);
	return errors.length === 0;
}

/**
 * Print verification results
 */
export function printVerificationResults(result: VerificationResult): void {
	if (result.success) {
		logger.info("✅ Type checking passed - no new errors introduced");

		if (result.fixedErrors.length > 0) {
			logger.info(`\n🎉 Fixed ${result.fixedErrors.length} existing error(s):`);
			for (const error of result.fixedErrors.slice(0, 5)) {
				logger.info(`   ${error}`);
			}
			if (result.fixedErrors.length > 5) {
				logger.info(`   ... and ${result.fixedErrors.length - 5} more`);
			}
		}
	} else {
		logger.error(
			`\n❌ Type checking failed - ${result.newErrors.length} new error(s) introduced:`
		);
		for (const error of result.newErrors.slice(0, 10)) {
			logger.error(`   ${error}`);
		}
		if (result.newErrors.length > 10) {
			logger.error(`   ... and ${result.newErrors.length - 10} more`);
		}
	}

	logger.info(
		`\nType errors: ${result.errorsAfter.length} total (${result.errorsBefore.length} before, ${result.newErrors.length} new, ${result.fixedErrors.length} fixed)`
	);

	if (
		result.unresolvableDiagnostics &&
		result.unresolvableDiagnostics.length > 0
	) {
		logger.warn(
			`⚠️  ${result.unresolvableDiagnostics.length} unresolvable import(s) detected after changes:`
		);
		for (const diag of result.unresolvableDiagnostics.slice(0, 10)) {
			logger.warn(`   ${diag.file}:${diag.line}: "${diag.specifier}"`);
		}
		if (result.unresolvableDiagnostics.length > 10) {
			logger.warn(
				`   ... and ${result.unresolvableDiagnostics.length - 10} more`
			);
		}
	}
}
