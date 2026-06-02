import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	classifyFreeVariables,
	type LocatedJsxNode,
	locateExtractComponentTarget,
	locateJsxNode,
	parseSelector,
	resolveJsxTsNode,
} from "./extract-component.ts";

const SAMPLE = `export function App() {
	const title = "hi";
	return (
		<div className="root">
			<Card title={title}>
				<span>body</span>
			</Card>
			<Footer />
		</div>
	);
}
`;

function parse(text = SAMPLE) {
	return createSourceFileFromText("sample.tsx", text);
}

describe("parseSelector", () => {
	test("parses an L-prefixed line range", () => {
		expect(parseSelector("L12-40")).toEqual({
			type: "range",
			start: 12,
			end: 40,
		});
	});

	test("parses a bare line range", () => {
		expect(parseSelector("3-9")).toEqual({ type: "range", start: 3, end: 9 });
	});

	test("treats a tag name as a name selector", () => {
		expect(parseSelector("Card")).toEqual({ type: "name", name: "Card" });
	});

	test("rejects an empty selector", () => {
		expect(() => parseSelector("   ")).toThrow(/must not be empty/);
	});

	test("rejects an inverted line range", () => {
		expect(() => parseSelector("L40-12")).toThrow(/must not exceed end/);
	});
});

describe("locateJsxNode — name selector", () => {
	test("locates a named element with children", () => {
		const node = locateJsxNode(parse(), "Card");
		expect(node.kind).toBe("element");
		expect(node.tagName).toBe("Card");
		expect(node.startLine).toBe(5);
	});

	test("locates a self-closing element", () => {
		const node = locateJsxNode(parse(), "Footer");
		expect(node.kind).toBe("self-closing");
		expect(node.tagName).toBe("Footer");
	});

	test("throws when no element matches the name", () => {
		expect(() => locateJsxNode(parse(), "Nope")).toThrow(
			/No JSX element named/
		);
	});

	test("throws an ambiguous error when a name matches twice", () => {
		const text = `export const A = () => (
	<div>
		<Card a={1} />
		<Card a={2} />
	</div>
);
`;
		expect(() => locateJsxNode(parse(text), "Card")).toThrow(
			/ambiguous — 2 matches/
		);
	});
});

describe("locateJsxNode — line-range selector", () => {
	test("selects the outermost node fully contained in the range", () => {
		// Lines 4-9 wrap the whole <div> subtree.
		const node = locateJsxNode(parse(), "L4-9");
		expect(node.kind).toBe("element");
		expect(node.tagName).toBe("div");
		expect(node.startLine).toBe(4);
	});

	test("selects an inner node when the range only covers it", () => {
		// Line 6 is just <span>body</span>.
		const node = locateJsxNode(parse(), "6-6");
		expect(node.tagName).toBe("span");
	});

	test("locates a fragment subtree", () => {
		const text = `export const F = () => (
	<>
		<a href="/">home</a>
	</>
);
`;
		const node: LocatedJsxNode = locateJsxNode(parse(text), "2-4");
		expect(node.kind).toBe("fragment");
		expect(node.tagName).toBeNull();
	});

	test("throws when nothing is contained in the range", () => {
		expect(() => locateJsxNode(parse(), "1-1")).toThrow(
			/No JSX element fully contained/
		);
	});

	test("throws when the file has no JSX at all", () => {
		const node = parse("export const x = 1;\n");
		expect(() => locateJsxNode(node, "Card")).toThrow(/No JSX elements found/);
	});
});

describe("locateExtractComponentTarget", () => {
	test("reads a file from disk and reports the located node", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "resect-extract-component-"));
		try {
			const file = path.join(dir, "App.tsx");
			writeFileSync(file, SAMPLE);
			const report = locateExtractComponentTarget(file, "Card", "Card.tsx");
			expect(report.file).toBe(file);
			expect(report.newFile).toBe("Card.tsx");
			expect(report.located.tagName).toBe("Card");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects an empty destination", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "resect-extract-component-"));
		try {
			const file = path.join(dir, "App.tsx");
			writeFileSync(file, SAMPLE);
			expect(() => locateExtractComponentTarget(file, "Card", "  ")).toThrow(
				/must not be empty/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws when the file cannot be parsed/read", () => {
		expect(() =>
			locateExtractComponentTarget("/no/such/file-xyz.tsx", "Card", "Card.tsx")
		).toThrow(/Could not parse file/);
	});
});

/**
 * Build an in-memory, type-bound program for a single `.tsx` source so the
 * checker-based classifier can be exercised without disk fixtures. The source
 * file is genuinely bound (parent pointers + a working checker), which is what
 * symbol-identity resolution requires.
 */
function buildProgram(text: string): {
	sourceFile: ts.SourceFile;
	checker: ts.TypeChecker;
} {
	const fileName = "sample.tsx";
	const options: ts.CompilerOptions = {
		jsx: ts.JsxEmit.ReactJSX,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
	};
	const host = ts.createCompilerHost(options);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, langVersion, onError, shouldCreate) => {
		if (name === fileName) {
			return ts.createSourceFile(
				name,
				text,
				ts.ScriptTarget.ESNext,
				true,
				ts.ScriptKind.TSX
			);
		}
		return originalGetSourceFile(name, langVersion, onError, shouldCreate);
	};
	const originalReadFile = host.readFile.bind(host);
	host.readFile = (name) => (name === fileName ? text : originalReadFile(name));
	const originalFileExists = host.fileExists.bind(host);
	host.fileExists = (name) => name === fileName || originalFileExists(name);
	const program = ts.createProgram([fileName], options, host);
	const sourceFile = program.getSourceFile(fileName);
	if (!sourceFile) {
		throw new Error("Failed to build in-memory program");
	}
	return { sourceFile, checker: program.getTypeChecker() };
}

function classify(text: string, selector: string) {
	const { sourceFile, checker } = buildProgram(text);
	const node = resolveJsxTsNode(sourceFile, selector);
	return classifyFreeVariables(node, sourceFile, checker);
}

describe("classifyFreeVariables — prop candidates", () => {
	test("collects a free param referenced in the subtree with its type", () => {
		const text = `function Greeting({ name }: { name: string }) {
	return <h1>Hello {name}</h1>;
}
`;
		const report = classify(text, "h1");
		expect(report.propCandidates).toEqual([{ name: "name", type: "string" }]);
		expect(report.unliftableHooks).toEqual([]);
		expect(report.blocked).toBe(false);
	});

	test("captures a destructured object-prop's resolved type", () => {
		const text = `function Profile({ user }: { user: { name: string } }) {
	return <div>{user.name}</div>;
}
`;
		const report = classify(text, "div");
		expect(report.propCandidates).toHaveLength(1);
		const [prop] = report.propCandidates;
		expect(prop?.name).toBe("user");
		expect(prop?.type).toContain("name");
		expect(report.blocked).toBe(false);
	});

	test("a member name is not surfaced as a free variable", () => {
		const text = `function Profile({ user }: { user: { name: string } }) {
	return <div>{user.name}</div>;
}
`;
		const report = classify(text, "div");
		expect(report.propCandidates.map((p) => p.name)).not.toContain("name");
	});
});

describe("classifyFreeVariables — unliftable hooks", () => {
	test("flags hook-derived values as unliftable, not props", () => {
		const text = `declare function useState<T>(init: T): [T, (next: T) => void];
function Counter() {
	const [count, setCount] = useState(0);
	return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`;
		const report = classify(text, "button");
		const hookNames = report.unliftableHooks.map((h) => h.name);
		expect(hookNames).toContain("count");
		expect(hookNames).toContain("setCount");
		for (const hook of report.unliftableHooks) {
			expect(hook.derivedFrom).toBe("useState");
		}
		expect(report.propCandidates.map((p) => p.name)).not.toContain("count");
		expect(report.blocked).toBe(true);
	});
});

describe("classifyFreeVariables — shadowing", () => {
	test("resolves to the inner binding, surfacing no false prop", () => {
		const text = `function List({ rows }: { rows: string[] }) {
	const label = "outer";
	return (
		<ul>
			{rows.map((label) => (
				<li>{label}</li>
			))}
		</ul>
	);
}
`;
		const report = classify(text, "ul");
		const propNames = report.propCandidates.map((p) => p.name);
		// `rows` is the genuine free variable; the inner `label` map param shadows
		// the outer `const label`, and is declared inside the subtree → bound.
		expect(propNames).toContain("rows");
		expect(propNames).not.toContain("label");
		expect(report.unliftableHooks).toEqual([]);
		expect(report.blocked).toBe(false);
	});
});
