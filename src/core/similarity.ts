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

/** Compile-time directives that prevent function consolidation */
const DIRECTIVE_PATTERN =
	/["']use (cache|cache:\s*\w+|server|client|strict)["']\s*;?/;

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
 * Extract semantic content tokens from a function body: uppercase identifiers
 * (constants, types, enum members) and string literal values. These carry
 * domain-specific meaning that normalization strips away.
 *
 * Used to detect structural coincidences: two functions with identical
 * normalized bodies but different content tokens are unlikely to be genuine
 * duplicates (e.g. `KEBAB_CASE_REGEX.test(s)` vs `HOOK_NAMING_REGEX.test(s)`).
 */
export function extractContentTokens(bodyText: string): string[] {
	// Remove comments
	let s = bodyText.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

	const tokens: string[] = [];

	// Extract string and template literal values (strip surrounding quotes)
	for (const m of s.matchAll(
		/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
	)) {
		tokens.push(m[0].slice(1, -1));
	}

	// Remove literals before extracting identifiers to avoid matching quoted text
	s = s
		.replace(/`(?:[^`\\]|\\.)*`/g, " ")
		.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");

	// Extract identifiers starting with an uppercase letter (constants, types,
	// enum members — these carry semantic intent unlike local camelCase vars)
	for (const m of s.matchAll(/\b[A-Z][a-zA-Z0-9_$]*\b/g)) {
		tokens.push(m[0]);
	}

	return tokens;
}

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
 * Detect if a function block body is a thin wrapper: exactly one statement
 * that is a return with a call expression (e.g. `return otherFn(a, b)`).
 */
function isWrapperBody(body: ts.Block): boolean {
	const statements = body.statements;
	if (statements.length !== 1) {
		return false;
	}
	const stmt = statements[0];
	if (!stmt) {
		return false;
	}
	// return someFunc(...)
	if (ts.isReturnStatement(stmt) && stmt.expression) {
		return ts.isCallExpression(stmt.expression);
	}
	// Bare expression statement: someFunc(...)
	if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
		return true;
	}
	return false;
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
					bodyLines: bodyText.split("\n").length,
					hasDirective: DIRECTIVE_PATTERN.test(bodyText),
					contentTokens: extractContentTokens(bodyText),
					isWrapper: isWrapperBody(stmt.body),
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
							bodyLines: bodyText.split("\n").length,
							hasDirective: DIRECTIVE_PATTERN.test(bodyText),
							contentTokens: extractContentTokens(bodyText),
							isWrapper: isWrapperBody(init.body),
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
/**
 * Check if a file path matches a related-path pattern.
 * Supports: exact file path, directory prefix, and glob patterns with *.
 */
export function matchesRelatedPath(filePath: string, pattern: string): boolean {
	const absFile = path.resolve(filePath);
	const absPattern = path.resolve(pattern);

	// Exact file match
	if (absFile === absPattern) {
		return true;
	}

	// Directory prefix match (pattern is a folder path)
	if (absFile.startsWith(`${absPattern}/`)) {
		return true;
	}

	// Glob pattern (contains * or ?)
	if (pattern.includes("*") || pattern.includes("?")) {
		const glob = new Bun.Glob(pattern);
		// Match against both absolute and the original relative path
		return glob.match(filePath) || glob.match(absFile);
	}

	return false;
}

export interface SimilarityFilterOptions {
	threshold?: number;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	/** Discard groups where every function lives in the same file */
	skipSameFile?: boolean;
	/** Only include groups containing at least one function from a matching path */
	onlyRelatedTo?: string;
	/** Exclude functions with fewer body lines than this threshold */
	minLines?: number;
	/** Exclude functions containing compile-time directives */
	skipDirectives?: boolean;
	/** Exclude thin wrapper functions (single return + call expression) */
	skipWrappers?: boolean;
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

	// Pre-filter: exclude functions below minimum line count or with directives
	let candidates = functions;
	if (opts.minLines !== undefined) {
		candidates = candidates.filter(
			(f) => f.bodyLines >= (opts.minLines as number)
		);
	}
	if (opts.skipDirectives) {
		candidates = candidates.filter((f) => !f.hasDirective);
	}
	if (opts.skipWrappers) {
		candidates = candidates.filter((f) => !f.isWrapper);
	}

	// Precompute token artifacts for all candidates to avoid redundant
	// tokenization and bigram generation inside the O(n^2) pairwise loop.
	const preTokens: string[][] = [];
	const preBigrams: string[][] = [];
	for (const fn of candidates) {
		const tokens = tokenize(fn.normalizedBody);
		preTokens.push(tokens);
		preBigrams.push(tokenBigrams(tokens));
	}

	const groups: SimilarityGroup[] = [];
	const assigned = new Set<number>();

	for (let i = 0; i < candidates.length; i++) {
		if (assigned.has(i)) {
			continue;
		}

		const fnI = candidates[i];
		if (!fnI) {
			continue;
		}
		const tokensI = preTokens[i];
		const bigramsI = preBigrams[i];
		const group: FunctionInfo[] = [fnI];
		let minScore = 1.0;

		for (let j = i + 1; j < candidates.length; j++) {
			if (assigned.has(j)) {
				continue;
			}

			const fnJ = candidates[j];
			if (!fnJ) {
				continue;
			}

			// Apply name filtering early — skip before expensive score
			// computation so that differently-named functions are never
			// candidates for grouping when sameNameOnly is active.
			if (sameNameOnly && fnI.name !== fnJ.name) {
				continue;
			}
			if (
				nameThresholdValue !== undefined &&
				nameSimilarity(fnI.name, fnJ.name) < nameThresholdValue
			) {
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
			const tokensJ = preTokens[j];
			const tokenRatio =
				Math.min(tokensI?.length ?? 0, tokensJ?.length ?? 0) /
				Math.max(tokensI?.length ?? 1, tokensJ?.length ?? 1);
			if (tokenRatio < 0.75) {
				continue;
			}

			let score: number;
			if (fnI.normalizedBody === fnJ.normalizedBody) {
				// Exact structural match — blend with content token similarity to detect
				// semantic false positives. Functions with identical structure but different
				// uppercase identifiers or string literals (e.g. KEBAB_CASE_REGEX vs
				// HOOK_NAMING_REGEX, or ["md5",...] vs ["query",...]) score < 1.0 and may
				// fall below the threshold, filtering structural coincidences.
				const contentSim = jaccardSimilarity(
					fnI.contentTokens,
					fnJ.contentTokens
				);
				score = 0.5 + 0.5 * contentSim;
			} else {
				// Use precomputed bigrams to capture token ordering — plain set
				// Jaccard gives misleading 1.0 for functions with the same token
				// vocabulary but different structure.
				score = jaccardSimilarity(bigramsI ?? [], preBigrams[j] ?? []);
			}

			if (score >= threshold) {
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

	let filtered = groups;

	// Filter out same-file groups when requested
	if (opts.skipSameFile) {
		filtered = filtered.filter((g) => {
			const files = new Set(g.functions.map((f) => f.file));
			return files.size > 1;
		});
	}

	// Filter to groups related to a specific path/glob
	if (opts.onlyRelatedTo) {
		const pattern = opts.onlyRelatedTo;
		filtered = filtered.filter((g) =>
			g.functions.some((f) => matchesRelatedPath(f.file, pattern))
		);
	}

	return filtered;
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
 * Collect functions from an array of file paths using bounded concurrency.
 */
async function collectFunctionsFromFiles(filePaths: string[]): Promise<{
	functions: FunctionInfo[];
	totalFiles: number;
}> {
	const { mapConcurrent } = await import("./concurrency.ts");
	const results = await mapConcurrent(
		filePaths,
		async (filePath) => {
			const content = await Bun.file(filePath).text();
			const sourceFile = ts.createSourceFile(
				filePath,
				content,
				ts.ScriptTarget.Latest,
				true
			);
			return collectFunctions(sourceFile, filePath);
		},
		{ onError: () => [] as FunctionInfo[] }
	);

	return { functions: results.flat(), totalFiles: filePaths.length };
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

	return await collectFunctionsFromFiles(allFiles);
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

	const { mapConcurrent } = await import("./concurrency.ts");
	const pkgFiles = await mapConcurrent(
		workspace.packages,
		async (pkg) => {
			const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
			const discovery = discoverProject(scanDir);
			return Array.from(discovery.fileOwnership.keys()).filter((fp) =>
				TS_JS_EXTENSIONS.test(fp)
			);
		},
		{ onError: () => [] as string[] }
	);
	const seen = new Set<string>();
	const allFiles: string[] = [];
	for (const files of pkgFiles) {
		for (const filePath of files) {
			if (!seen.has(filePath)) {
				seen.add(filePath);
				allFiles.push(filePath);
			}
		}
	}

	const bounded = filterToWorkspaceBoundary(allFiles, workspace.root);
	const result = await collectFunctionsFromFiles(bounded);
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
	skipSameFile?: boolean;
	onlyRelatedTo?: string;
	minLines?: number;
	skipDirectives?: boolean;
	skipWrappers?: boolean;
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
		skipSameFile: opts.skipSameFile,
		onlyRelatedTo: opts.onlyRelatedTo,
		minLines: opts.minLines,
		skipDirectives: opts.skipDirectives,
		skipWrappers: opts.skipWrappers,
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
