import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import type { ProjectConfig } from "../types.ts";
import { TSC_ERROR_PATTERN } from "./constants.ts";
import { createProgram } from "./project.ts";
import { scanExports, scanUnresolvableImports } from "./scanner.ts";

export interface VerificationResult {
	success: boolean;
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	fixedErrors: string[];
	/** Count of unresolvable imports detected after changes */
	unresolvableAfter?: number;
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

	// Count unresolvable imports after changes are applied
	const program = createProgram(project);
	let unresolvableAfter = 0;
	for (const file of project.files) {
		const sf = program.getSourceFile(file);
		if (sf) {
			unresolvableAfter += scanUnresolvableImports(sf, project).length;
		}
	}

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
		unresolvableAfter,
	};
}

/**
 * Run TypeScript compiler in noEmit mode and capture errors
 */
export function runTypeCheck(project: ProjectConfig): string[] {
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

	if (result.unresolvableAfter && result.unresolvableAfter > 0) {
		logger.warn(
			`⚠️  ${result.unresolvableAfter} unresolvable import(s) detected after changes`
		);
	}
}

export interface ConflictResult {
	hasConflict: boolean;
	conflicts: Array<{ file: string; name: string; line: number }>;
}

/**
 * Check if export names from a source file already exist in a target module.
 * Used by move and rename to detect when an operation would overwrite
 * an existing export symbol in the target.
 */
export function checkExportConflict(
	targetSourceFile: ts.SourceFile,
	exportNames: string[]
): ConflictResult {
	const targetExports = scanExports(targetSourceFile);
	const nameSet = new Set(exportNames);
	const conflicts: ConflictResult["conflicts"] = [];

	for (const exp of targetExports) {
		if (nameSet.has(exp.name)) {
			conflicts.push({
				file: targetSourceFile.fileName,
				name: exp.name,
				line: exp.line,
			});
		}
	}

	return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Check if a file already declares a local binding with the given name.
 *
 * Skip criteria (use one):
 * - `skipSpecifier`: Skip import bindings from this module specifier (for move)
 * - `skipImportedName`: Skip import bindings where the imported name matches (for rename)
 *
 * Used by move and rename to detect when updating an import would
 * introduce a duplicate binding in the importing file.
 */
export function hasLocalBinding(
	sourceFile: ts.SourceFile,
	name: string,
	skipSpecifier: string,
	skipImportedName?: string
): boolean {
	let found = false;

	function visit(node: ts.Node) {
		if (found) {
			return;
		}

		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name
		) {
			found = true;
			return;
		}

		if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
			found = true;
			return;
		}

		if (ts.isClassDeclaration(node) && node.name?.text === name) {
			found = true;
			return;
		}

		if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
			found = true;
			return;
		}

		if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
			found = true;
			return;
		}

		if (ts.isEnumDeclaration(node) && node.name.text === name) {
			found = true;
			return;
		}

		// Check import bindings with skip criteria
		if (ts.isImportSpecifier(node) && node.name.text === name) {
			// For rename: skip if the imported name matches skipImportedName
			if (skipImportedName) {
				const importedName = node.propertyName?.text ?? node.name.text;
				if (importedName === skipImportedName) {
					// This is the binding being renamed — don't flag it
					ts.forEachChild(node, visit);
					return;
				}
				found = true;
				return;
			}
			// For move: skip imports from the module being changed
			const importDecl = node.parent?.parent?.parent;
			if (
				importDecl &&
				ts.isImportDeclaration(importDecl) &&
				ts.isStringLiteral(importDecl.moduleSpecifier) &&
				importDecl.moduleSpecifier.text !== skipSpecifier
			) {
				found = true;
				return;
			}
		}

		if (ts.isNamespaceImport(node) && node.name.text === name) {
			found = true;
			return;
		}

		if (ts.isImportClause(node) && node.name && node.name.text === name) {
			found = true;
			return;
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return found;
}

/**
 * Check all importing files for binding conflicts that would result
 * from renaming an export or moving a module.
 *
 * For each file that imports the given export names without aliases,
 * checks if that file already has a local binding with the same name.
 */
export function checkBindingConflicts(
	importingFiles: Array<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}>,
	exportNames: Set<string>
): ConflictResult {
	const conflicts: ConflictResult["conflicts"] = [];

	for (const { sourceFile, specifier, bindings } of importingFiles) {
		for (const binding of bindings) {
			if (binding.alias) {
				continue;
			}
			if (!exportNames.has(binding.name)) {
				continue;
			}
			if (hasLocalBinding(sourceFile, binding.name, specifier)) {
				conflicts.push({
					file: sourceFile.fileName,
					name: binding.name,
					line: 0,
				});
				break;
			}
		}
	}

	return { hasConflict: conflicts.length > 0, conflicts };
}

export interface AllConflictCheckOptions {
	exportNames: string[];
	targetSourceFile?: ts.SourceFile;
	importingFiles: Array<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}>;
	skipImportedName?: string;
}

/**
 * Perform all conflict checks in a single call.
 * Composes checkExportConflict and checkBindingConflicts.
 */
export function checkAllConflicts(
	options: AllConflictCheckOptions
): ConflictResult {
	const allConflicts: ConflictResult["conflicts"] = [];
	const nameSet = new Set(options.exportNames);

	if (options.targetSourceFile) {
		const exportResult = checkExportConflict(
			options.targetSourceFile,
			options.exportNames
		);
		allConflicts.push(...exportResult.conflicts);
	}

	if (options.skipImportedName) {
		for (const { sourceFile, bindings } of options.importingFiles) {
			for (const binding of bindings) {
				if (binding.alias || !nameSet.has(binding.name)) {
					continue;
				}
				if (
					hasLocalBinding(
						sourceFile,
						binding.name,
						"",
						options.skipImportedName
					)
				) {
					allConflicts.push({
						file: sourceFile.fileName,
						name: binding.name,
						line: 0,
					});
					break;
				}
			}
		}
	} else {
		const bindingResult = checkBindingConflicts(
			options.importingFiles,
			nameSet
		);
		allConflicts.push(...bindingResult.conflicts);
	}

	return { hasConflict: allConflicts.length > 0, conflicts: allConflicts };
}
