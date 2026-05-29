import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	type LocatedJsxNode,
	locateExtractComponentTarget,
	locateJsxNode,
	parseSelector,
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
