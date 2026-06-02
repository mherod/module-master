import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { parseSourceFile } from "../core/source-file.ts";
import type { ReadOnlyCommandOptions } from "../types.ts";

/**
 * `extract-component` — pull a JSX/TSX subtree into its own typed module.
 *
 * This is slice 1 of the epic (#107): the command scaffold plus selector
 * resolution. It is **read-only / dry-run only** — it locates the target JSX
 * node and reports it. Free-variable/hook classification (#108), Props-interface
 * + component codegen (#109), and the call-site rewrite + verify/rollback (#110)
 * land in later slices. No files are written here.
 */
export interface ExtractComponentOptions extends ReadOnlyCommandOptions {
	/** Path to the source file containing the JSX to extract */
	file: string;
	/**
	 * Which JSX node to extract. Two forms:
	 * - line range: `L<start>-<end>` or `<start>-<end>` (1-based, inclusive)
	 * - element/component name: a JSX tag name (e.g. `Card`, `div`)
	 */
	selector: string;
	/** Destination module the extracted component will eventually be written to */
	newFile: string;
	/** Emit the report as JSON instead of human-readable text */
	json?: boolean;
}

export type JsxNodeKind = "element" | "self-closing" | "fragment";

/** The JSX node a selector resolved to. Char offsets are 0-based; lines 1-based. */
export interface LocatedJsxNode {
	kind: JsxNodeKind;
	/** Tag name for elements/self-closing elements; `null` for fragments */
	tagName: string | null;
	start: number;
	end: number;
	startLine: number;
	endLine: number;
}

export interface ExtractComponentReport {
	file: string;
	selector: string;
	newFile: string;
	located: LocatedJsxNode;
}

type ParsedSelector =
	| { type: "range"; start: number; end: number }
	| { type: "name"; name: string };

const LINE_RANGE_PATTERN = /^L?(\d+)-(\d+)$/;

/**
 * Parse a selector string into a structured form. A `L12-30`/`12-30` shape is a
 * line range; anything else is treated as a JSX tag/component name.
 */
export function parseSelector(selector: string): ParsedSelector {
	const trimmed = selector.trim();
	if (trimmed.length === 0) {
		throw new Error("Selector must not be empty");
	}
	const rangeMatch = trimmed.match(LINE_RANGE_PATTERN);
	if (rangeMatch) {
		const start = Number(rangeMatch[1]);
		const end = Number(rangeMatch[2]);
		if (start < 1 || end < 1) {
			throw new Error(
				`Line range must use 1-based line numbers: "${selector}"`
			);
		}
		if (start > end) {
			throw new Error(
				`Line range start must not exceed end: "${selector}" (${start} > ${end})`
			);
		}
		return { type: "range", start, end };
	}
	return { type: "name", name: trimmed };
}

function isJsxNode(
	node: ts.Node
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
	return (
		ts.isJsxElement(node) ||
		ts.isJsxSelfClosingElement(node) ||
		ts.isJsxFragment(node)
	);
}

function collectJsxNodes(
	sourceFile: ts.SourceFile
): Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> {
	const nodes: Array<
		ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment
	> = [];
	const visit = (node: ts.Node): void => {
		if (isJsxNode(node)) {
			nodes.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return nodes;
}

function jsxTagName(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
	sourceFile: ts.SourceFile
): string | null {
	if (ts.isJsxElement(node)) {
		return node.openingElement.tagName.getText(sourceFile);
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return node.tagName.getText(sourceFile);
	}
	return null;
}

function jsxNodeKind(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment
): JsxNodeKind {
	if (ts.isJsxElement(node)) {
		return "element";
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return "self-closing";
	}
	return "fragment";
}

function toLocatedNode(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
	sourceFile: ts.SourceFile
): LocatedJsxNode {
	const start = node.getStart(sourceFile);
	const end = node.getEnd();
	const kind: JsxNodeKind = jsxNodeKind(node);
	return {
		kind,
		tagName: jsxTagName(node, sourceFile),
		start,
		end,
		startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
		endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
	};
}

function describeCandidate(node: LocatedJsxNode): string {
	const label =
		node.kind === "fragment" ? "<>…</>" : `<${node.tagName ?? "?"}>`;
	return `${label} (lines ${node.startLine}-${node.endLine})`;
}

/**
 * Resolve a selector to exactly one JSX node in `sourceFile`.
 *
 * Throws a descriptive error when nothing matches or when the selector is
 * ambiguous (more than one top-level match). Shared by the CLI command and the
 * MCP tool so selection behaves identically across entry points.
 */
export function locateJsxNode(
	sourceFile: ts.SourceFile,
	selector: string
): LocatedJsxNode {
	const parsed = parseSelector(selector);
	const jsxNodes = collectJsxNodes(sourceFile);
	if (jsxNodes.length === 0) {
		throw new Error("No JSX elements found in file");
	}

	if (parsed.type === "name") {
		const matches = jsxNodes.filter(
			(node) => jsxTagName(node, sourceFile) === parsed.name
		);
		return pickSingleMatch(
			matches.map((node) => toLocatedNode(node, sourceFile)),
			selector,
			`No JSX element named "${parsed.name}" found`
		);
	}

	// Line-range selector: keep JSX nodes fully contained in [start, end], then
	// drop any nested inside another contained node so only the outermost
	// subtree(s) remain.
	const contained = jsxNodes
		.map((node) => toLocatedNode(node, sourceFile))
		.filter(
			(node) => node.startLine >= parsed.start && node.endLine <= parsed.end
		);
	const topLevel = contained.filter(
		(node) =>
			!contained.some(
				(other) =>
					other !== node && other.start <= node.start && other.end >= node.end
			)
	);
	return pickSingleMatch(
		topLevel,
		selector,
		`No JSX element fully contained in lines ${parsed.start}-${parsed.end}`
	);
}

function pickSingleMatch(
	matches: LocatedJsxNode[],
	selector: string,
	emptyMessage: string
): LocatedJsxNode {
	const [first, second] = matches;
	if (!first) {
		throw new Error(emptyMessage);
	}
	if (second) {
		const list = matches.map((m) => `  - ${describeCandidate(m)}`).join("\n");
		throw new Error(
			`Selector "${selector}" is ambiguous — ${matches.length} matches:\n${list}\nNarrow it with a line range (e.g. L${first.startLine}-${first.endLine}).`
		);
	}
	return first;
}

/**
 * Parse `filePath`, resolve `selector`, and produce the dry-run report. Pure
 * compute seam reused by both the CLI command and the MCP tool.
 */
export function locateExtractComponentTarget(
	filePath: string,
	selector: string,
	newFile: string
): ExtractComponentReport {
	if (newFile.trim().length === 0) {
		throw new Error("Destination <new-file> must not be empty");
	}
	const sourceFile = parseSourceFile(filePath);
	if (!sourceFile) {
		throw new Error(`Could not parse file: ${filePath}`);
	}
	const located = locateJsxNode(sourceFile, selector);
	return { file: filePath, selector, newFile, located };
}

// ── Free-variable collection + classification (#108) ──────────────────

/** A free identifier that becomes a prop on the extracted component. */
export interface PropCandidate {
	/** Identifier name as it appears in the subtree. */
	name: string;
	/** Resolved type string, suitable for Props-interface codegen (#109). */
	type: string;
}

/**
 * A free identifier whose value derives from a React hook call in the parent
 * component body. Lifting it into a child detaches it from the hook and changes
 * behavior, so it cannot be passed as a plain prop.
 */
export interface UnliftableHook {
	/** Identifier name as it appears in the subtree. */
	name: string;
	/** The hook the value derives from, e.g. `useState`. */
	derivedFrom: string;
}

/**
 * Classification report for the free variables of a target JSX subtree.
 * `blocked` is the default policy: extraction is refused while unliftable hook
 * values are referenced, so the offending hooks surface instead of being
 * silently misclassified as props.
 */
export interface FreeVariableReport {
	propCandidates: PropCandidate[];
	unliftableHooks: UnliftableHook[];
	blocked: boolean;
}

const HOOK_NAME_PATTERN = /^use[A-Z]/;

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node)
	);
}

/** Nearest function-like ancestor of `node` — the component owning the JSX. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (isFunctionLike(current)) {
			return current;
		}
		current = current.parent;
	}
	return undefined;
}

function isWithinSpan(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	start: number,
	end: number
): boolean {
	const nodeStart = node.getStart(sourceFile);
	const nodeEnd = node.getEnd();
	return nodeStart >= start && nodeEnd <= end;
}

/**
 * If `declaration` is (or sits inside) a variable declaration whose initializer
 * is a `use*` hook call, return the hook name; otherwise `null`. Covers both
 * `const value = useMemo(...)` and destructured `const [v, setV] = useState(...)`.
 */
function hookOrigin(declaration: ts.Node): string | null {
	let current: ts.Node | undefined = declaration;
	while (
		current &&
		!ts.isVariableDeclaration(current) &&
		(ts.isBindingElement(current) ||
			ts.isObjectBindingPattern(current) ||
			ts.isArrayBindingPattern(current))
	) {
		current = current.parent;
	}
	if (!(current && ts.isVariableDeclaration(current))) {
		return null;
	}
	const { initializer } = current;
	if (
		initializer &&
		ts.isCallExpression(initializer) &&
		ts.isIdentifier(initializer.expression) &&
		HOOK_NAME_PATTERN.test(initializer.expression.text)
	) {
		return initializer.expression.text;
	}
	return null;
}

/**
 * Identifiers that are member/attribute/property *names* (not value
 * references) never resolve to a free scope variable — exclude them so a
 * property access like `user.name` doesn't surface `name` as a prop.
 */
function isReferencePosition(node: ts.Identifier, parent: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
		return false;
	}
	if (ts.isQualifiedName(parent) && parent.right === node) {
		return false;
	}
	if (ts.isJsxAttribute(parent) && parent.name === node) {
		return false;
	}
	if (ts.isPropertyAssignment(parent) && parent.name === node) {
		return false;
	}
	return true;
}

/**
 * Collect and classify the free variables of `jsxNode` using the type-checker
 * (symbol identity, never name matching — so shadowing resolves correctly).
 *
 * A free identifier is one whose declaring symbol lives in the *owning
 * component function* but *outside* the extracted subtree:
 * - declared inside the subtree → bound (e.g. a `.map` callback param), skipped.
 * - declared at module scope / via import → available in the new module, skipped.
 * - declared in the owner but outside the subtree → free local → classified as a
 *   prop candidate, or an unliftable hook when its value derives from a hook call.
 */
export function classifyFreeVariables(
	jsxNode: ts.Node,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker
): FreeVariableReport {
	const owner = enclosingFunction(jsxNode);
	const subtreeStart = jsxNode.getStart(sourceFile);
	const subtreeEnd = jsxNode.getEnd();
	const ownerStart = owner?.getStart(sourceFile) ?? 0;
	const ownerEnd = owner?.getEnd() ?? 0;

	const propCandidates: PropCandidate[] = [];
	const unliftableHooks: UnliftableHook[] = [];
	const seen = new Set<ts.Symbol>();

	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (ts.isIdentifier(node) && isReferencePosition(node, parent)) {
			const symbol = checker.getSymbolAtLocation(node);
			const declaration = symbol?.getDeclarations()?.[0];
			if (symbol && declaration && !seen.has(symbol)) {
				const declInSubtree = isWithinSpan(
					declaration,
					sourceFile,
					subtreeStart,
					subtreeEnd
				);
				const declInOwner =
					owner !== undefined &&
					isWithinSpan(declaration, sourceFile, ownerStart, ownerEnd);
				if (!declInSubtree && declInOwner) {
					seen.add(symbol);
					const hook = hookOrigin(declaration);
					if (hook) {
						unliftableHooks.push({ name: node.text, derivedFrom: hook });
					} else {
						const type = checker.typeToString(
							checker.getTypeOfSymbolAtLocation(symbol, node)
						);
						propCandidates.push({ name: node.text, type });
					}
				}
			}
		}
		ts.forEachChild(node, (child) => {
			visit(child, node);
		});
	};
	ts.forEachChild(jsxNode, (child) => {
		visit(child, jsxNode);
	});

	return {
		propCandidates,
		unliftableHooks,
		blocked: unliftableHooks.length > 0,
	};
}

/**
 * Resolve a selector to the concrete `ts` JSX node (not just its offsets) within
 * `sourceFile`. Reuses {@link locateJsxNode} for selection + ambiguity handling,
 * then matches the located span back to the AST node so the checker-based
 * analysis can walk it.
 */
export function resolveJsxTsNode(
	sourceFile: ts.SourceFile,
	selector: string
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
	const located = locateJsxNode(sourceFile, selector);
	const match = collectJsxNodes(sourceFile).find(
		(node) =>
			node.getStart(sourceFile) === located.start &&
			node.getEnd() === located.end
	);
	if (!match) {
		throw new Error("Could not resolve located JSX node back to the AST");
	}
	return match;
}

/**
 * Locate the target JSX node, build the shared program/checker in a single
 * `createProgram` pass (mirroring `analyze`), and classify its free variables.
 * Read-only: parses + type-checks, writes nothing.
 */
export function analyzeExtractComponentFreeVariables(
	options: ExtractComponentOptions
): FreeVariableReport {
	const absolutePath = path.resolve(options.file);
	const tsconfigPath = resolveTsConfig(
		options.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		throw new Error("Could not find tsconfig.json");
	}
	const project = loadProject(tsconfigPath, absolutePath);
	const program = createProgram(project, [absolutePath]);
	const sourceFile = program.getSourceFile(absolutePath);
	if (!sourceFile) {
		throw new Error(`Could not parse file: ${absolutePath}`);
	}
	const jsxNode = resolveJsxTsNode(sourceFile, options.selector);
	return classifyFreeVariables(jsxNode, sourceFile, program.getTypeChecker());
}

export function extractComponentCommand(
	options: ExtractComponentOptions
): void {
	const { file, selector, newFile, json } = options;
	const absolutePath = path.resolve(file);

	let report: ExtractComponentReport;
	try {
		report = locateExtractComponentTarget(absolutePath, selector, newFile);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	// Free-variable classification (#108) requires the type-checker, so it can
	// only run when the file resolves to a tsconfig project. Degrade gracefully
	// when it doesn't — the locate report is still useful on its own.
	let classification: FreeVariableReport | null = null;
	let classificationError: string | null = null;
	try {
		classification = analyzeExtractComponentFreeVariables(options);
	} catch (error) {
		classificationError =
			error instanceof Error ? error.message : String(error);
	}

	if (json) {
		logger.info(JSON.stringify({ ...report, classification }, null, 2));
		return;
	}

	const { located } = report;
	logger.info(
		"\n🧩 extract-component (dry-run — slices 1-2: locate + classify)"
	);
	logger.info(`   File:     ${report.file}`);
	logger.info(`   Selector: ${report.selector}`);
	logger.info(`   New file: ${report.newFile}`);
	logger.empty();
	logger.info("📍 Target JSX node:");
	logger.info(`   ${describeCandidate(located)}`);
	logger.info(`   kind: ${located.kind}`);
	logger.info(`   span: chars ${located.start}-${located.end}`);
	logger.empty();
	printClassification(classification, classificationError);
	logger.info(
		"Read-only: no files written. Codegen (#109) and rewrite+verify (#110) follow."
	);
}

function printClassification(
	classification: FreeVariableReport | null,
	error: string | null
): void {
	if (!classification) {
		logger.info(`🔍 Free-variable analysis skipped: ${error ?? "unavailable"}`);
		logger.empty();
		return;
	}

	const { propCandidates, unliftableHooks, blocked } = classification;
	logger.info("🔍 Free-variable classification:");
	if (propCandidates.length === 0) {
		logger.info("   Prop candidates: none");
	} else {
		logger.info("   Prop candidates:");
		for (const prop of propCandidates) {
			logger.info(`     - ${prop.name}: ${prop.type}`);
		}
	}
	if (unliftableHooks.length > 0) {
		logger.info("   Unliftable hooks (block extraction):");
		for (const hook of unliftableHooks) {
			logger.info(`     - ${hook.name} (from ${hook.derivedFrom})`);
		}
	}
	logger.info(
		blocked
			? "   ⛔ Extraction blocked: subtree references hook-derived values."
			: "   ✅ Extraction safe: no unliftable hooks referenced."
	);
	logger.empty();
}
