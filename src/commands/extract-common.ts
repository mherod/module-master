import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import {
	calculateRelativeSpecifier,
	findCrossPackageImport,
	isCrossPackageMove,
} from "../core/resolver.ts";
import { withSourceFile } from "../core/scanner.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import type { FunctionInfo, SimilarityGroup } from "../types.ts";

/**
 * Compute the import specifier for a file importing from importTarget.
 * When workspace info is available and the files are in different packages,
 * uses the package name instead of a relative path.
 */
function computeSpecifier(
	filePath: string,
	importTarget: string,
	ws?: WorkspaceInfo
): string {
	if (ws && isCrossPackageMove(filePath, importTarget, ws)) {
		const pkgImport = findCrossPackageImport(importTarget, ws);
		if (pkgImport) {
			return pkgImport;
		}
	}
	return calculateRelativeSpecifier(filePath, importTarget);
}

export interface ExtractCommonOptions {
	directory: string;
	project?: string;
	threshold?: number;
	dryRun?: boolean;
	group?: number;
	workspace?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	skipSameFile?: boolean;
	onlyRelatedTo?: string;
	minLines?: number;
	skipDirectives?: boolean;
	skipWrappers?: boolean;
	/** Write the canonical function to this file instead of keeping it in place */
	output?: string;
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
						bodyLines: 0,
						hasDirective: false,
						contentTokens: [],
						isWrapper: false,
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
							bodyLines: 0,
							hasDirective: false,
							contentTokens: [],
							isWrapper: false,
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
	return withSourceFile(
		fn.file,
		(sourceFile) => findFunctionNode(sourceFile, fn.file, fn.name, fn.line),
		null
	);
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
 * Replace function nodes in their files with import/re-export statements.
 * Groups nodes by file so multiple removals in the same file are batched.
 */
async function replaceNodesWithImports(
	nodes: FunctionNode[],
	importTarget: string,
	ws?: WorkspaceInfo
): Promise<string[]> {
	const filesModified: string[] = [];
	const byFile = new Map<string, FunctionNode[]>();
	for (const node of nodes) {
		const existing = byFile.get(node.info.file) ?? [];
		existing.push(node);
		byFile.set(node.info.file, existing);
	}

	for (const [filePath, fileNodes] of byFile) {
		const content = await Bun.file(filePath).text();
		const changes: TextChange[] = [];
		const imports: string[] = [];

		for (const node of fileNodes) {
			changes.push({ start: node.start, end: node.end, newText: "" });
			const specifier = computeSpecifier(filePath, importTarget, ws);
			const stmt = node.exported
				? `export { ${node.info.name} } from "${specifier}";`
				: `import { ${node.info.name} } from "${specifier}";`;
			imports.push(stmt);
		}

		let newContent = applyTextChanges(content, changes);
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
		newContent = newContent.replace(/\n{3,}/g, "\n\n");
		await Bun.write(filePath, newContent);
		filesModified.push(filePath);
	}

	return filesModified;
}

/**
 * Apply an extraction plan to the filesystem.
 */
async function applyPlan(
	plan: ExtractionPlan,
	ws?: WorkspaceInfo
): Promise<{
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

	// Step 2: Replace duplicates with imports from the canonical file
	const modified = await replaceNodesWithImports(
		plan.duplicates,
		plan.canonical.info.file,
		ws
	);
	filesModified.push(...modified);

	return {
		filesModified: [...new Set(filesModified)],
		functionsRemoved: plan.duplicates.length,
	};
}

/**
 * Apply an extraction plan by writing the canonical function to a specified
 * output file and replacing ALL copies (including the original canonical) with
 * imports from the output file.
 */
async function applyPlanToOutput(
	plan: ExtractionPlan,
	outputFile: string,
	ws?: WorkspaceInfo
): Promise<{ filesModified: string[]; functionsRemoved: number }> {
	const filesModified: string[] = [];
	const absOutput = path.resolve(outputFile);

	// Step 1: Build the function text to write (ensure it's exported)
	let fnText = plan.canonical.text.trimStart();
	if (!plan.canonical.exported) {
		fnText = `export ${fnText}`;
	}

	// Step 2: Append to or create the output file
	let existingContent = "";
	try {
		existingContent = await Bun.file(absOutput).text();
	} catch {
		// File doesn't exist yet — will be created
	}
	const separator = existingContent.length > 0 ? "\n\n" : "";
	await Bun.write(absOutput, `${existingContent}${separator}${fnText}\n`);
	filesModified.push(absOutput);

	// Step 3: Remove function from ALL files and replace with imports
	const allNodes = [plan.canonical, ...plan.duplicates];
	const modified = await replaceNodesWithImports(allNodes, absOutput, ws);
	filesModified.push(...modified);

	return {
		filesModified: [...new Set(filesModified)],
		functionsRemoved: allNodes.length,
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
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
		output,
	} = options;
	const absoluteDir = path.resolve(directory);

	const scope = workspace ? "across workspace packages in" : "in";
	logger.info(
		`\n${dryRun ? "🔍 Dry run:" : "🔧"} Extracting common functions ${scope} ${absoluteDir}\n`
	);

	// Step 0: Discover workspace if --workspace is enabled
	const { discoverWorkspace } = await import("../core/workspace.ts");
	const ws = workspace ? await discoverWorkspace(absoluteDir) : undefined;

	// Step 1: Find similar groups
	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		projectRoot: project,
		workspace,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
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

	const absOutput = output ? path.resolve(output) : undefined;

	for (let i = 0; i < plans.length; i++) {
		const plan = plans[i];
		if (!plan) {
			continue;
		}

		logger.info(
			`📦 Group ${targetGroup ?? i + 1}: ${plan.canonical.info.name}`
		);

		if (absOutput) {
			const outputRel = path.relative(absoluteDir, absOutput);
			logger.info(`   ${dryRun ? "Would write to" : "Write to"}: ${outputRel}`);
			const allSources = [plan.canonical, ...plan.duplicates];
			for (const node of allSources) {
				const rel = path.relative(absoluteDir, node.info.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${rel}:${node.info.line}`
				);
			}
		} else {
			const canonicalRel = path.relative(absoluteDir, plan.canonical.info.file);
			logger.info(`   Keep in: ${canonicalRel}:${plan.canonical.info.line}`);
			for (const dup of plan.duplicates) {
				const dupRel = path.relative(absoluteDir, dup.info.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${dupRel}:${dup.info.line}`
				);
			}
		}
		logger.empty();

		if (dryRun) {
			totalRemoved += absOutput
				? plan.duplicates.length + 1
				: plan.duplicates.length;
		} else if (absOutput) {
			const result = await applyPlanToOutput(plan, absOutput, ws ?? undefined);
			totalRemoved += result.functionsRemoved;
			allModified.push(...result.filesModified);
		} else {
			const result = await applyPlan(plan, ws ?? undefined);
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
