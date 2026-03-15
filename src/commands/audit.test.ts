import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../core/graph.ts";
import type { ModuleReference } from "../types.ts";
import { detectCycles } from "./audit.ts";

function makeRef(sourceFile: string, resolvedPath: string): ModuleReference {
	return {
		sourceFile,
		specifier: resolvedPath,
		resolvedPath,
		type: "import-named",
		line: 1,
		column: 1,
		isTypeOnly: false,
	};
}

function makeGraph(edges: [string, string][]): DependencyGraph {
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();

	for (const [from, to] of edges) {
		const existing = imports.get(from) ?? [];
		existing.push(makeRef(from, to));
		imports.set(from, existing);

		const rev = importedBy.get(to) ?? [];
		rev.push(makeRef(from, to));
		importedBy.set(to, rev);
	}

	return { imports, importedBy, barrelFiles, barrelReExports };
}

describe("detectCycles", () => {
	test("returns empty for acyclic graph", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/c.ts"],
		]);
		expect(detectCycles(graph)).toEqual([]);
	});

	test("detects simple two-node cycle", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		expect(cycles[0].files).toContain("/a.ts");
		expect(cycles[0].files).toContain("/b.ts");
	});

	test("detects three-node cycle", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/c.ts"],
			["/c.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		expect(cycles[0].files.length).toBe(3);
	});

	test("does not duplicate cycles", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
			["/c.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		// Only one cycle: a <-> b. c -> a is not a cycle.
		expect(cycles.length).toBe(1);
	});

	test("detects multiple independent cycles", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
			["/x.ts", "/y.ts"],
			["/y.ts", "/x.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(2);
	});

	test("handles self-referencing file", () => {
		const graph = makeGraph([["/a.ts", "/a.ts"]]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		expect(cycles[0].files).toEqual(["/a.ts"]);
	});
});
