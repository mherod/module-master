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
 * When keepExtension is true, preserves the file extension in relative paths
 * (needed for projects using moduleResolution: bundler with allowImportingTsExtensions).
 */
function computeSpecifier(
	filePath: string,
	importTarget: string,
	ws?: WorkspaceInfo,
	keepExtension = false
): string {
	if (ws && isCrossPackageMove(filePath, importTarget, ws)) {
		const pkgImport = findCrossPackageImport(importTarget, ws);
		if (pkgImport) {
			return pkgImport;
		}
	}
	const spec = calculateRelativeSpecifier(filePath, importTarget);
	if (keepExtension) {
		const ext = path.extname(importTarget);
		if (ext && !spec.endsWith(ext)) {
			return `${spec}${ext}`;
		}
	}
	return spec;
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
	/** Start byte offset including leading trivia (JSDoc, comments, whitespace) — used for removal */
	start: number;
	/** Start byte offset after leading trivia — used for export keyword insertion */
	actualStart: number;
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

/** Pending changes to apply to a single file */
interface FileUpdate {
	changes: TextChange[];
	imports: string[];
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
				const fullStart = stmt.getFullStart();
				const actualStart = stmt.getStart(sourceFile);
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
					actualStart,
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
					const actualStart = stmt.getStart(sourceFile);
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
						actualStart,
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
 * Get or create the FileUpdate entry for a given file path.
 */
function getOrCreateUpdate(
	updates: Map<string, FileUpdate>,
	filePath: string
): FileUpdate {
	let update = updates.get(filePath);
	if (!update) {
		update = { changes: [], imports: [] };
		updates.set(filePath, update);
	}
	return update;
}

/**
 * Build the import/re-export statement for a duplicate being replaced.
 * Uses the canonical name, aliasing to the duplicate's name when they differ
 * so that existing call sites within the file continue to work.
 */
function buildImportStatement(
	dup: FunctionNode,
	canonicalName: string,
	specifier: string
): string {
	const dupName = dup.info.name;
	// When names differ, alias: `import { canonical as dup }` so existing
	// references to the duplicate's name remain valid.
	const importedName =
		dupName === canonicalName
			? canonicalName
			: `${canonicalName} as ${dupName}`;
	return dup.exported
		? `export { ${importedName} } from "${specifier}";`
		: `import { ${importedName} } from "${specifier}";`;
}

/**
 * Collect all file changes for a plan into the update map.
 * This deferred approach lets us apply ALL changes to each file in a single
 * pass, preventing stale-position corruption when multiple plans touch the
 * same file.
 *
 * Same-file duplicates (canonical and duplicate in the same file) are handled
 * by removing the duplicate body only — no self-import is generated.
 */
function collectPlanUpdates(
	plan: ExtractionPlan,
	updates: Map<string, FileUpdate>,
	keepExtension: boolean,
	ws?: WorkspaceInfo
): void {
	const canonicalFile = plan.canonical.info.file;
	const canonicalName = plan.canonical.info.name;

	// Ensure canonical is exported (insert "export " before its keyword)
	if (!plan.canonical.exported) {
		getOrCreateUpdate(updates, canonicalFile).changes.push({
			start: plan.canonical.actualStart,
			end: plan.canonical.actualStart,
			newText: "export ",
		});
	}

	for (const dup of plan.duplicates) {
		// Always remove the duplicate function body
		getOrCreateUpdate(updates, dup.info.file).changes.push({
			start: dup.start,
			end: dup.end,
			newText: "",
		});

		// Skip import generation when duplicate is in the same file as the
		// canonical — adding `import { x } from "./sameFile"` would be circular.
		if (dup.info.file === canonicalFile) {
			continue;
		}

		const specifier = computeSpecifier(
			dup.info.file,
			canonicalFile,
			ws,
			keepExtension
		);
		getOrCreateUpdate(updates, dup.info.file).imports.push(
			buildImportStatement(dup, canonicalName, specifier)
		);
	}
}

/**
 * Collect all file changes for an --output plan into the update map.
 * All copies (canonical + duplicates) are removed from their source files
 * and replaced with imports from the output file.
 */
function collectPlanToOutputUpdates(
	plan: ExtractionPlan,
	absOutput: string,
	updates: Map<string, FileUpdate>,
	keepExtension: boolean,
	ws?: WorkspaceInfo
): void {
	const canonicalName = plan.canonical.info.name;
	const allNodes = [plan.canonical, ...plan.duplicates];

	for (const node of allNodes) {
		getOrCreateUpdate(updates, node.info.file).changes.push({
			start: node.start,
			end: node.end,
			newText: "",
		});

		// No self-import for nodes already in the output file
		if (node.info.file === absOutput) {
			continue;
		}

		const specifier = computeSpecifier(
			node.info.file,
			absOutput,
			ws,
			keepExtension
		);
		getOrCreateUpdate(updates, node.info.file).imports.push(
			buildImportStatement(node, canonicalName, specifier)
		);
	}
}

/**
 * Apply all pending file updates: removals then import insertions, in one
 * read+write per file.
 */
async function applyFileUpdates(
	updates: Map<string, FileUpdate>
): Promise<string[]> {
	const filesModified: string[] = [];
	for (const [filePath, update] of updates) {
		const content = await Bun.file(filePath).text();
		let newContent = applyTextChanges(content, update.changes);

		if (update.imports.length > 0) {
			const importBlock = update.imports.join("\n");
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
		}

		newContent = newContent.replace(/\n{3,}/g, "\n\n");
		await Bun.write(filePath, newContent);
		filesModified.push(filePath);
	}
	return filesModified;
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

/**
 * Detect whether the project requires explicit file extensions in imports
 * (moduleResolution: bundler + allowImportingTsExtensions).
 * Reads tsconfig.json directly; does not follow `extends` chains.
 */
async function detectKeepExtension(
	dir: string,
	project?: string
): Promise<boolean> {
	const candidates = [project, dir].filter(Boolean) as string[];
	for (const searchDir of candidates) {
		const tsconfigPath = path.join(searchDir, "tsconfig.json");
		try {
			const content = await Bun.file(tsconfigPath).text();
			const config = JSON.parse(content) as {
				compilerOptions?: { allowImportingTsExtensions?: boolean };
			};
			if (config.compilerOptions?.allowImportingTsExtensions === true) {
				return true;
			}
		} catch {
			// ignore missing or unparseable tsconfig
		}
	}
	return false;
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
	const absOutput = output ? path.resolve(output) : undefined;

	// Detect whether imports need explicit .ts extensions
	const keepExtension = dryRun
		? false
		: await detectKeepExtension(absoluteDir, project);

	// Collect all file changes across all plans before writing anything.
	// This prevents stale-position corruption when multiple plans affect the
	// same file (Bug 3).
	const fileUpdates = new Map<string, FileUpdate>();

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
			totalRemoved += allSources.length;
		} else {
			const canonicalRel = path.relative(absoluteDir, plan.canonical.info.file);
			logger.info(`   Keep in: ${canonicalRel}:${plan.canonical.info.line}`);
			for (const dup of plan.duplicates) {
				const dupRel = path.relative(absoluteDir, dup.info.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${dupRel}:${dup.info.line}`
				);
			}
			totalRemoved += plan.duplicates.length;
		}
		logger.empty();

		if (!dryRun) {
			if (absOutput) {
				// Write canonical function to the output file first (sequential append)
				let fnText = plan.canonical.text.trimStart();
				if (!plan.canonical.exported) {
					fnText = `export ${fnText}`;
				}
				let existingContent = "";
				try {
					existingContent = await Bun.file(absOutput).text();
				} catch {
					// File doesn't exist yet — will be created
				}
				const separator = existingContent.length > 0 ? "\n\n" : "";
				await Bun.write(absOutput, `${existingContent}${separator}${fnText}\n`);

				collectPlanToOutputUpdates(
					plan,
					absOutput,
					fileUpdates,
					keepExtension,
					ws ?? undefined
				);
			} else {
				collectPlanUpdates(plan, fileUpdates, keepExtension, ws ?? undefined);
			}
		}
	}

	// Apply all collected file changes in one pass per file
	const allModified = dryRun ? [] : await applyFileUpdates(fileUpdates);

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
