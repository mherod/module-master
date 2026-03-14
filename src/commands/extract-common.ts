import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { calculateRelativeSpecifier } from "../core/resolver.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import type { FunctionInfo, SimilarityGroup } from "../types.ts";

export interface ExtractCommonOptions {
	directory: string;
	project?: string;
	threshold?: number;
	dryRun?: boolean;
	group?: number;
	workspace?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
}

interface FunctionNode {
	info: FunctionInfo;
	/** Start byte offset of the full statement (including export, JSDoc) */
	start: number;
	/** End byte offset of the full statement */
	end: number;
	/** Full text of the statement */
	text: string;
	/** Whether the function has an export modifier */
	exported: boolean;
}

interface ExtractionPlan {
	group: SimilarityGroup;
	/** The function copy to keep (canonical source) */
	canonical: FunctionNode;
	/** Copies to remove and replace with imports */
	duplicates: FunctionNode[];
}

/**
 * Find the AST node for a function at a given line in a source file.
 * Returns position and text information needed for extraction.
 */
function findFunctionNode(
	sourceFile: ts.SourceFile,
	filePath: string,
	functionName: string,
	targetLine: number
): FunctionNode | null {
	for (const stmt of sourceFile.statements) {
		if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === functionName) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				stmt.getStart(sourceFile)
			);
			if (line + 1 === targetLine) {
				const end = stmt.getEnd();
				// Include leading trivia (JSDoc, comments) by using full start
				const fullStart = stmt.getFullStart();
				const text = sourceFile.text.slice(fullStart, end);
				const exported =
					stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
					false;
				return {
					info: {
						file: filePath,
						name: functionName,
						line: targetLine,
						column: 0,
						normalizedBody: "",
						tokenCount: 0,
						bodyLength: 0,
					},
					start: fullStart,
					end,
					text,
					exported,
				};
			}
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name) || decl.name.text !== functionName) {
					continue;
				}
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				if (line + 1 === targetLine) {
					const end = stmt.getEnd();
					// Include semicolon if present
					const afterEnd = sourceFile.text.charCodeAt(end);
					const actualEnd = afterEnd === 59 /* ; */ ? end + 1 : end;
					const fullStart = stmt.getFullStart();
					const text = sourceFile.text.slice(fullStart, actualEnd);
					const exported =
						stmt.modifiers?.some(
							(m) => m.kind === ts.SyntaxKind.ExportKeyword
						) ?? false;
					return {
						info: {
							file: filePath,
							name: functionName,
							line: targetLine,
							column: 0,
							normalizedBody: "",
							tokenCount: 0,
							bodyLength: 0,
						},
						start: fullStart,
						end: actualEnd,
						text,
						exported,
					};
				}
			}
		}
	}
	return null;
}

/**
 * Parse a file and find the function node.
 */
function locateFunctionNode(fn: FunctionInfo): FunctionNode | null {
	const content = ts.sys.readFile(fn.file);
	if (!content) {
		return null;
	}
	const sourceFile = ts.createSourceFile(
		fn.file,
		content,
		ts.ScriptTarget.Latest,
		true
	);
	return findFunctionNode(sourceFile, fn.file, fn.name, fn.line);
}

/**
 * Pick the canonical function from a group. Prefers the first function
 * that is already exported, falling back to the first in the group.
 */
function pickCanonical(nodes: FunctionNode[]): {
	canonical: FunctionNode;
	duplicates: FunctionNode[];
} {
	const exportedIdx = nodes.findIndex((n) => n.exported);
	const canonicalIdx = exportedIdx >= 0 ? exportedIdx : 0;
	const canonical = nodes[canonicalIdx];
	if (!canonical) {
		return { canonical: nodes[0] as FunctionNode, duplicates: nodes.slice(1) };
	}
	const duplicates = nodes.filter((_, i) => i !== canonicalIdx);
	return { canonical, duplicates };
}

/**
 * Build extraction plans for all eligible groups.
 */
function planExtractions(groups: SimilarityGroup[]): ExtractionPlan[] {
	const plans: ExtractionPlan[] = [];

	for (const group of groups) {
		const nodes: FunctionNode[] = [];
		for (const fn of group.functions) {
			const node = locateFunctionNode(fn);
			if (node) {
				nodes.push(node);
			}
		}
		if (nodes.length < 2) {
			continue;
		}
		const { canonical, duplicates } = pickCanonical(nodes);
		plans.push({ group, canonical, duplicates });
	}

	return plans;
}

/**
 * Ensure the canonical function is exported. If not, adds the export keyword.
 */
function ensureExported(node: FunctionNode): TextChange | null {
	if (node.exported) {
		return null;
	}
	// Add "export " before the function/const keyword
	return { start: node.start, end: node.start, newText: "export " };
}

/**
 * Remove a function from a file and add an import from the canonical file.
 */
function buildChangesForDuplicate(
	duplicate: FunctionNode,
	canonical: FunctionNode
): { removal: TextChange; importText: string } {
	// Remove the function (replace with empty string, trimming surrounding blank lines)
	const removal: TextChange = {
		start: duplicate.start,
		end: duplicate.end,
		newText: "",
	};

	// Calculate the import specifier
	const specifier = calculateRelativeSpecifier(
		duplicate.info.file,
		canonical.info.file
	);

	// Build import statement
	const importText = duplicate.exported
		? `export { ${duplicate.info.name} } from "${specifier}";`
		: `import { ${duplicate.info.name} } from "${specifier}";`;

	return { removal, importText };
}

/**
 * Apply an extraction plan to the filesystem.
 */
async function applyPlan(plan: ExtractionPlan): Promise<{
	filesModified: string[];
	functionsRemoved: number;
}> {
	const filesModified: string[] = [];

	// Step 1: Ensure canonical is exported
	const exportChange = ensureExported(plan.canonical);
	if (exportChange) {
		const content = await Bun.file(plan.canonical.info.file).text();
		const newContent = applyTextChanges(content, [exportChange]);
		await Bun.write(plan.canonical.info.file, newContent);
		filesModified.push(plan.canonical.info.file);
	}

	// Step 2: Process each duplicate
	// Group duplicates by file (multiple duplicates might be in the same file)
	const byFile = new Map<string, FunctionNode[]>();
	for (const dup of plan.duplicates) {
		const existing = byFile.get(dup.info.file) ?? [];
		existing.push(dup);
		byFile.set(dup.info.file, existing);
	}

	for (const [filePath, dups] of byFile) {
		const content = await Bun.file(filePath).text();
		const changes: TextChange[] = [];
		const imports: string[] = [];

		for (const dup of dups) {
			const { removal, importText } = buildChangesForDuplicate(
				dup,
				plan.canonical
			);
			changes.push(removal);
			imports.push(importText);
		}

		// Apply removals
		let newContent = applyTextChanges(content, changes);

		// Add imports at the top (after any existing imports)
		const importBlock = imports.join("\n");
		const lastImportIdx = findLastImportEnd(newContent);
		if (lastImportIdx > 0) {
			newContent =
				newContent.slice(0, lastImportIdx) +
				"\n" +
				importBlock +
				newContent.slice(lastImportIdx);
		} else {
			newContent = `${importBlock}\n${newContent}`;
		}

		// Clean up excessive blank lines
		newContent = newContent.replace(/\n{3,}/g, "\n\n");

		await Bun.write(filePath, newContent);
		filesModified.push(filePath);
	}

	return {
		filesModified: [...new Set(filesModified)],
		functionsRemoved: plan.duplicates.length,
	};
}

/**
 * Find the byte offset of the end of the last import statement in the content.
 */
function findLastImportEnd(content: string): number {
	const sf = ts.createSourceFile(
		"temp.ts",
		content,
		ts.ScriptTarget.Latest,
		true
	);
	let lastImportEnd = 0;
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			lastImportEnd = stmt.getEnd();
		} else if (!ts.isImportDeclaration(stmt) && lastImportEnd > 0) {
			break;
		}
	}
	return lastImportEnd;
}

export async function extractCommonCommand(
	options: ExtractCommonOptions
): Promise<void> {
	const {
		directory,
		project,
		threshold = 0.95,
		dryRun = false,
		group: targetGroup,
		workspace = false,
		nameThreshold,
		sameNameOnly,
	} = options;
	const absoluteDir = path.resolve(directory);

	logger.info(
		`\n${dryRun ? "🔍 Dry run:" : "🔧"} Extracting common functions in ${absoluteDir}\n`
	);

	// Step 1: Find similar groups
	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		projectRoot: project,
		workspace,
		nameThreshold,
		sameNameOnly,
	});

	if (report.groups.length === 0) {
		logger.info("✅ No similar function groups found at this threshold.");
		logger.empty();
		return;
	}

	// Step 2: Filter to target group if specified
	const groups =
		targetGroup === undefined
			? report.groups
			: report.groups.slice(targetGroup - 1, targetGroup);

	if (groups.length === 0) {
		logger.error(
			`Error: group ${targetGroup} does not exist (${report.groups.length} groups found)`
		);
		process.exit(1);
	}

	// Step 3: Build extraction plans
	const plans = planExtractions(groups);

	if (plans.length === 0) {
		logger.info(
			"No extractable groups found (functions could not be located in AST)."
		);
		logger.empty();
		return;
	}

	// Step 4: Report / execute
	let totalRemoved = 0;
	const allModified: string[] = [];

	for (let i = 0; i < plans.length; i++) {
		const plan = plans[i];
		if (!plan) {
			continue;
		}
		const canonicalRel = path.relative(absoluteDir, plan.canonical.info.file);

		logger.info(
			`📦 Group ${targetGroup ?? i + 1}: ${plan.canonical.info.name}`
		);
		logger.info(`   Keep in: ${canonicalRel}:${plan.canonical.info.line}`);

		for (const dup of plan.duplicates) {
			const dupRel = path.relative(absoluteDir, dup.info.file);
			logger.info(
				`   ${dryRun ? "Would remove from" : "Remove from"}: ${dupRel}:${dup.info.line}`
			);
		}
		logger.empty();

		if (dryRun) {
			totalRemoved += plan.duplicates.length;
		} else {
			const result = await applyPlan(plan);
			totalRemoved += result.functionsRemoved;
			allModified.push(...result.filesModified);
		}
	}

	// Summary
	const uniqueFiles = [...new Set(allModified)];
	if (dryRun) {
		logger.info(
			`Would extract ${plans.length} group(s), removing ${totalRemoved} duplicate(s).`
		);
	} else {
		logger.info(
			`✅ Extracted ${plans.length} group(s), removed ${totalRemoved} duplicate(s) across ${uniqueFiles.length} file(s).`
		);
	}
	logger.empty();
}
