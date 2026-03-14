import path from "node:path";
import ts from "typescript";
import type {
	FunctionInfo,
	SimilarityBucket,
	SimilarityGroup,
	SimilarityReport,
} from "../types.ts";
import { TS_JS_EXTENSIONS } from "./constants.ts";
import { discoverProject } from "./tsconfig-discovery.ts";

/** Minimum token count for a function body to be included */
const MIN_TOKEN_COUNT = 8;

const JS_KEYWORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"async",
	"await",
	"of",
	"from",
	"as",
	"type",
	"interface",
	"enum",
	"implements",
	"declare",
	"abstract",
	"readonly",
	"override",
]);

/**
 * Normalize a function body text by replacing identifiers, string literals,
 * and numeric literals with stable placeholders. Structural tokens (keywords,
 * punctuation) are preserved so that the shape of the body is captured.
 */
export function normalizeBody(text: string): string {
	// Remove line comments
	let s = text.replace(/\/\/[^\n]*/g, "");
	// Remove block comments
	s = s.replace(/\/\*[\s\S]*?\*\//g, "");
	// Replace template literals (before string literals to avoid overlap)
	s = s.replace(/`(?:[^`\\]|\\.)*`/g, "$S");
	// Replace string literals
	s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "$S");
	// Replace numeric literals (must come before identifier replacement)
	s = s.replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "$N");
	// Replace non-keyword identifiers with $I.
	// The lookbehind (?<!\$) prevents re-replacing the S/N in already-placed $S/$N.
	s = s.replace(/(?<!\$)\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (match) =>
		JS_KEYWORDS.has(match) ? match : "$I"
	);
	// Collapse whitespace
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

/**
 * Tokenize a normalized body into individual tokens.
 * Handles placeholders ($I, $S, $N), keywords/identifiers, and punctuation.
 */
export function tokenize(normalized: string): string[] {
	return (
		normalized.match(/\$[ISN]|[a-zA-Z_$][a-zA-Z0-9_$]*|\d+|[^\s\w$]/g) ?? []
	);
}

/**
 * Build bigrams (adjacent token pairs) from a token array.
 * Captures local ordering so that functions with the same token vocabulary
 * but different structure produce different bigram sets.
 */
export function tokenBigrams(tokens: string[]): string[] {
	const bigrams: string[] = [];
	for (let i = 0; i < tokens.length - 1; i++) {
		bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
	}
	return bigrams;
}

/**
 * Compute Jaccard similarity between two string arrays using set intersection.
 * Returns 1.0 for two empty inputs (treat as identical).
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection++;
		}
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 1 : intersection / union;
}

/**
 * Split a camelCase or PascalCase identifier into lowercase tokens.
 * E.g., "makeTempDir" → ["make", "temp", "dir"],
 *       "XMLParser" → ["xml", "parser"].
 */
export function camelCaseTokenize(name: string): string[] {
	return name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[\s_]+/)
		.filter(Boolean);
}

/**
 * Compute name similarity between two function names using Jaccard on
 * camelCase tokens. Returns 1.0 for identical names, 0.0 for completely
 * different names.
 */
export function nameSimilarity(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	const tokensA = camelCaseTokenize(a);
	const tokensB = camelCaseTokenize(b);
	return jaccardSimilarity(tokensA, tokensB);
}

function scoreToBucket(score: number): SimilarityBucket | null {
	if (score >= 0.999) {
		return "exact";
	}
	if (score >= 0.85) {
		return "high";
	}
	if (score >= 0.7) {
		return "medium";
	}
	return null;
}

/**
 * Collect all top-level function declarations and named const arrow/function
 * expressions from a source file.
 */
export function collectFunctions(
	sourceFile: ts.SourceFile,
	filePath: string
): FunctionInfo[] {
	const functions: FunctionInfo[] = [];

	for (const stmt of sourceFile.statements) {
		// function foo() {} or export function foo() {}
		if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
			const bodyText = stmt.body.getText(sourceFile);
			const normalized = normalizeBody(bodyText);
			const tokens = tokenize(normalized);
			if (tokens.length >= MIN_TOKEN_COUNT) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				functions.push({
					file: filePath,
					name: stmt.name.text,
					line: line + 1,
					column: character,
					normalizedBody: normalized,
					tokenCount: tokens.length,
					bodyLength: bodyText.length,
				});
			}
		}
		// const foo = () => { ... } or const foo = function() { ... }
		else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!(ts.isIdentifier(decl.name) && decl.initializer)) {
					continue;
				}
				const init = decl.initializer;
				if (
					(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
					init.body &&
					ts.isBlock(init.body)
				) {
					const bodyText = init.body.getText(sourceFile);
					const normalized = normalizeBody(bodyText);
					const tokens = tokenize(normalized);
					if (tokens.length >= MIN_TOKEN_COUNT) {
						const { line, character } =
							sourceFile.getLineAndCharacterOfPosition(
								stmt.getStart(sourceFile)
							);
						functions.push({
							file: filePath,
							name: decl.name.text,
							line: line + 1,
							column: character,
							normalizedBody: normalized,
							tokenCount: tokens.length,
							bodyLength: bodyText.length,
						});
					}
				}
			}
		}
	}

	return functions;
}

/**
 * Group a list of functions by similarity score above the given threshold.
 * Uses exact normalized-body comparison for "exact" bucket and Jaccard
 * similarity for "high" and "medium" buckets.
 *
 * Each function appears in at most one group (greedy assignment).
 */
export interface SimilarityFilterOptions {
	threshold?: number;
	nameThreshold?: number;
	sameNameOnly?: boolean;
}

export function findSimilarGroups(
	functions: FunctionInfo[],
	thresholdOrOptions: number | SimilarityFilterOptions = 0.8
): SimilarityGroup[] {
	const opts =
		typeof thresholdOrOptions === "number"
			? { threshold: thresholdOrOptions }
			: thresholdOrOptions;
	const threshold = opts.threshold ?? 0.8;
	const nameThresholdValue = opts.nameThreshold;
	const sameNameOnly = opts.sameNameOnly ?? false;
	const groups: SimilarityGroup[] = [];
	const assigned = new Set<number>();

	for (let i = 0; i < functions.length; i++) {
		if (assigned.has(i)) {
			continue;
		}

		const fnI = functions[i];
		if (!fnI) {
			continue;
		}
		const tokensI = tokenize(fnI.normalizedBody);
		const group: FunctionInfo[] = [fnI];
		let minScore = 1.0;

		for (let j = i + 1; j < functions.length; j++) {
			if (assigned.has(j)) {
				continue;
			}

			const fnJ = functions[j];
			if (!fnJ) {
				continue;
			}

			// Skip if original body sizes are very different — avoids false
			// positives where normalization collapses large and small functions
			// to the same token set (e.g. a 40-line template vs a 1-liner).
			const sizeRatio =
				Math.min(fnI.bodyLength, fnJ.bodyLength) /
				Math.max(fnI.bodyLength, fnJ.bodyLength);
			if (sizeRatio < 0.5) {
				continue;
			}

			// Skip if token counts differ significantly — Jaccard on sets
			// ignores frequency, so functions with the same unique tokens but
			// different lengths (e.g. a.has(b) vs a.b.has(c(d))) get a
			// misleading 1.0 score.
			const tokensJ = tokenize(fnJ.normalizedBody);
			const tokenRatio =
				Math.min(tokensI.length, tokensJ.length) /
				Math.max(tokensI.length, tokensJ.length);
			if (tokenRatio < 0.75) {
				continue;
			}

			let score: number;
			if (fnI.normalizedBody === fnJ.normalizedBody) {
				// Exact match after normalization — same structure, only name/literal differences
				score = 1.0;
			} else {
				// Use bigrams to capture token ordering — plain set Jaccard
				// gives misleading 1.0 for functions with the same token
				// vocabulary but different structure.
				score = jaccardSimilarity(tokenBigrams(tokensI), tokenBigrams(tokensJ));
			}

			if (score >= threshold) {
				// Apply name filtering when enabled
				if (sameNameOnly && fnI.name !== fnJ.name) {
					continue;
				}
				if (
					nameThresholdValue !== undefined &&
					nameSimilarity(fnI.name, fnJ.name) < nameThresholdValue
				) {
					continue;
				}

				group.push(fnJ);
				assigned.add(j);
				minScore = Math.min(minScore, score);
			}
		}

		if (group.length > 1) {
			assigned.add(i);
			const bucket = scoreToBucket(minScore);
			if (bucket) {
				groups.push({ bucket, score: minScore, functions: group });
			}
		}
	}

	// Sort by score descending (best matches first)
	groups.sort((a, b) => b.score - a.score);
	return groups;
}

/**
 * Walk up from `dir` to find the nearest ancestor directory that contains a
 * tsconfig.json. Returns `dir` itself if none is found (graceful fallback).
 */
function findProjectRoot(dir: string): string {
	let current = path.resolve(dir);
	while (true) {
		if (ts.sys.fileExists(path.join(current, "tsconfig.json"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(dir);
		}
		current = parent;
	}
}

/**
 * Collect functions from an array of file paths.
 */
function collectFunctionsFromFiles(filePaths: string[]): {
	functions: FunctionInfo[];
	totalFiles: number;
} {
	const functions: FunctionInfo[] = [];

	for (const filePath of filePaths) {
		const content = ts.sys.readFile(filePath);
		if (!content) {
			continue;
		}
		try {
			const sourceFile = ts.createSourceFile(
				filePath,
				content,
				ts.ScriptTarget.Latest,
				true
			);
			const fileFunctions = collectFunctions(sourceFile, filePath);
			functions.push(...fileFunctions);
		} catch {
			// Skip files that cannot be parsed
		}
	}

	return { functions, totalFiles: filePaths.length };
}

/**
 * Scan all TypeScript/JavaScript files in a project directory and collect
 * top-level function declarations and named const function expressions.
 *
 * @param directory - Directory to scan (results are filtered to files under this path)
 * @param projectRoot - Optional explicit project root containing tsconfig.json.
 *   When omitted, the nearest tsconfig.json ancestor of `directory` is used.
 */
export async function scanProjectFunctions(
	directory: string,
	projectRoot?: string
): Promise<{ functions: FunctionInfo[]; totalFiles: number }> {
	const absoluteDir = path.resolve(directory);
	const rootDir = projectRoot
		? path.resolve(projectRoot)
		: findProjectRoot(absoluteDir);

	const discovery = discoverProject(rootDir);
	const allFiles = Array.from(discovery.fileOwnership.keys()).filter(
		(f) => TS_JS_EXTENSIONS.test(f) && f.startsWith(absoluteDir)
	);

	return collectFunctionsFromFiles(allFiles);
}

/**
 * Scan all TypeScript/JavaScript files across workspace packages and collect
 * top-level function declarations and named const function expressions.
 * Each package's tsconfig is used for file discovery when available, falling
 * back to directory-based discovery.
 */
export async function scanWorkspaceFunctions(directory: string): Promise<{
	functions: FunctionInfo[];
	totalFiles: number;
	packageCount: number;
}> {
	const { discoverWorkspace, filterToWorkspaceBoundary } = await import(
		"./workspace.ts"
	);
	const absDir = path.resolve(directory);
	const workspace = await discoverWorkspace(absDir);
	if (!workspace || workspace.packages.length === 0) {
		return { functions: [], totalFiles: 0, packageCount: 0 };
	}

	// Guard: reject if directory is outside workspace root
	if (filterToWorkspaceBoundary([absDir], workspace.root).length === 0) {
		return { functions: [], totalFiles: 0, packageCount: 0 };
	}

	const allFiles: string[] = [];
	const seen = new Set<string>();

	for (const pkg of workspace.packages) {
		const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;

		const discovery = discoverProject(scanDir);
		for (const filePath of discovery.fileOwnership.keys()) {
			if (TS_JS_EXTENSIONS.test(filePath) && !seen.has(filePath)) {
				seen.add(filePath);
				allFiles.push(filePath);
			}
		}
	}

	const bounded = filterToWorkspaceBoundary(allFiles, workspace.root);
	const result = collectFunctionsFromFiles(bounded);
	return { ...result, packageCount: workspace.packages.length };
}

/**
 * Run the full similarity analysis on a project directory.
 * When workspace is true, scans across all workspace packages.
 *
 * @param directory - Directory to scan
 * @param threshold - Similarity threshold (0–1, default 0.8)
 * @param projectRoot - Optional project root containing tsconfig.json
 * @param workspace - When true, scan across all workspace packages
 */
export interface AnalyzeSimilarityOptions {
	directory: string;
	threshold?: number;
	projectRoot?: string;
	workspace?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
}

export async function analyzeSimilarity(
	directoryOrOpts: string | AnalyzeSimilarityOptions,
	threshold = 0.8,
	projectRoot?: string,
	workspace = false
): Promise<SimilarityReport & { packageCount?: number }> {
	const opts: AnalyzeSimilarityOptions =
		typeof directoryOrOpts === "string"
			? { directory: directoryOrOpts, threshold, projectRoot, workspace }
			: directoryOrOpts;
	const dir = opts.directory;
	const th = opts.threshold ?? threshold;
	const pr = opts.projectRoot ?? projectRoot;
	const ws = opts.workspace ?? workspace;
	const filterOpts: SimilarityFilterOptions = {
		threshold: th,
		nameThreshold: opts.nameThreshold,
		sameNameOnly: opts.sameNameOnly,
	};

	if (ws) {
		const result = await scanWorkspaceFunctions(dir);
		const groups = findSimilarGroups(result.functions, filterOpts);
		return {
			groups,
			totalFunctions: result.functions.length,
			totalFiles: result.totalFiles,
			packageCount: result.packageCount,
		};
	}

	const { functions, totalFiles } = await scanProjectFunctions(dir, pr);
	const groups = findSimilarGroups(functions, filterOpts);
	return { groups, totalFunctions: functions.length, totalFiles };
}
