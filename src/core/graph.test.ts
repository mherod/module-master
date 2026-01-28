import { describe, expect, test } from "bun:test";
import type { ModuleReference } from "../types";
import { type DependencyGraph, findAllReferences } from "./graph";

describe("findAllReferences", () => {
	// Mock graph helper
	const createMockGraph = (
		imports: Record<string, string[]>, // file -> imports
		reExports: Record<string, string[]> // barrel -> re-exported files
	): DependencyGraph => {
		const importMap = new Map<string, ModuleReference[]>();
		const importedBy = new Map<string, ModuleReference[]>();
		const barrelFiles = new Set<string>();
		const barrelReExports = new Map<string, string[]>();

		// Setup barrel re-exports
		for (const [barrel, files] of Object.entries(reExports)) {
			barrelFiles.add(barrel);
			barrelReExports.set(barrel, files);
		}

		// Setup imports and reverse lookups
		for (const [file, deps] of Object.entries(imports)) {
			const refs = deps.map(
				(dep) =>
					({
						sourceFile: file,
						specifier: `./${dep}`,
						resolvedPath: dep,
						type: "import",
						line: 1,
						column: 1,
						isTypeOnly: false,
					}) as ModuleReference
			);
			importMap.set(file, refs);

			for (const ref of refs) {
				const existing = importedBy.get(ref.resolvedPath) ?? [];
				existing.push(ref);
				importedBy.set(ref.resolvedPath, existing);
			}
		}

		return {
			imports: importMap,
			importedBy,
			barrelFiles,
			barrelReExports,
		};
	};

	test("finds direct references", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/target.ts"],
			},
			{}
		);

		const refs = findAllReferences("src/target.ts", graph);
		expect(refs).toHaveLength(1);
		expect(refs[0]?.sourceFile).toBe("src/consumer.ts");
	});

	test("finds references through single barrel", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel.ts"],
				"src/barrel.ts": ["src/target.ts"],
			},
			{
				"src/barrel.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);
		// Should find:
		// 1. Consumer -> Barrel (indirect)
		// 2. Barrel -> Target (direct)
		expect(refs).toHaveLength(2);

		const consumerRef = refs.find((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRef).toBeDefined();
		expect(consumerRef?.resolvedPath).toBe("src/target.ts");

		const barrelRef = refs.find((r) => r.sourceFile === "src/barrel.ts");
		expect(barrelRef).toBeDefined();
	});

	test("finds references through recursive barrels (A -> Barrel1 -> Barrel2 -> Consumer)", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel2.ts"],
				"src/barrel2.ts": ["src/barrel1.ts"],
				"src/barrel1.ts": ["src/target.ts"],
			},
			{
				"src/barrel2.ts": ["src/barrel1.ts"],
				"src/barrel1.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);

		// Consumer -> Barrel2 -> Barrel1 -> Target
		// findAllReferences should return:
		// 1. Consumer (imports Barrel2)
		// 2. Barrel2 (imports Barrel1) -- technically an importer in the chain

		expect(refs.some((r) => r.sourceFile === "src/consumer.ts")).toBe(true);

		const consumerRef = refs.find((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRef?.resolvedPath).toBe("src/target.ts");
	});

	test("handles diamond dependencies (avoid duplicates)", () => {
		// A -> Barrel1 -> Consumer
		// A -> Barrel2 -> Consumer
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel1.ts", "src/barrel2.ts"],
				"src/barrel1.ts": ["src/target.ts"],
				"src/barrel2.ts": ["src/target.ts"],
			},
			{
				"src/barrel1.ts": ["src/target.ts"],
				"src/barrel2.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);
		// Should find consumer twice (two different import statements)
		const consumerRefs = refs.filter((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRefs).toHaveLength(2);
	});
});
