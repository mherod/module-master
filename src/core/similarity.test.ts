import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
	collectFunctions,
	findSimilarGroups,
	jaccardSimilarity,
	normalizeBody,
	tokenize,
} from "./similarity";

function makeSourceFile(code: string, fileName = "test.ts"): ts.SourceFile {
	return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

describe("normalizeBody", () => {
	test("replaces string literals with $S", () => {
		const result = normalizeBody('{ return "hello world"; }');
		expect(result).toBe("{ return $S; }");
	});

	test("replaces numeric literals with $N", () => {
		const result = normalizeBody("{ return 42; }");
		expect(result).toBe("{ return $N; }");
	});

	test("replaces non-keyword identifiers with $I", () => {
		const result = normalizeBody("{ const x = foo(); return x; }");
		expect(result).toBe("{ const $I = $I(); return $I; }");
	});

	test("preserves keywords", () => {
		const result = normalizeBody("{ if (true) { return null; } }");
		expect(result).toBe("{ if (true) { return null; } }");
	});

	test("handles template literals", () => {
		const result = normalizeBody("{ return `hello world`; }");
		expect(result).toBe("{ return $S; }");
	});

	test("removes line comments", () => {
		const result = normalizeBody("{ // a comment\n return x; }");
		expect(result).not.toContain("comment");
		expect(result).toBe("{ return $I; }");
	});

	test("removes block comments", () => {
		const result = normalizeBody("{ /* block */ return x; }");
		expect(result).toBe("{ return $I; }");
	});

	test("collapses whitespace", () => {
		const result = normalizeBody("{   const   x   =   1;   }");
		expect(result).toBe("{ const $I = $N; }");
	});

	test("two functions differing only in variable names normalize identically", () => {
		const a = normalizeBody(
			"{ const date = input.toISOString(); return date.split('T')[0]; }"
		);
		const b = normalizeBody(
			"{ const ts = value.toISOString(); return ts.split('T')[0]; }"
		);
		expect(a).toBe(b);
	});

	test("two functions differing only in string literals normalize identically", () => {
		const a = normalizeBody("{ return arr.join(', '); }");
		const b = normalizeBody("{ return arr.join(' | '); }");
		expect(a).toBe(b);
	});
});

describe("tokenize", () => {
	test("splits on punctuation and whitespace", () => {
		const tokens = tokenize("{ return $I; }");
		expect(tokens).toEqual(["{", "return", "$I", ";", "}"]);
	});

	test("handles chained calls", () => {
		const tokens = tokenize("$I.$I($S)");
		expect(tokens).toEqual(["$I", ".", "$I", "(", "$S", ")"]);
	});

	test("returns empty array for empty string", () => {
		expect(tokenize("")).toEqual([]);
	});
});

describe("jaccardSimilarity", () => {
	test("returns 1.0 for identical token sets", () => {
		const tokens = ["a", "b", "c"];
		expect(jaccardSimilarity(tokens, tokens)).toBe(1);
	});

	test("returns 0 for completely disjoint sets", () => {
		expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
	});

	test("returns 1.0 for two empty arrays", () => {
		expect(jaccardSimilarity([], [])).toBe(1);
	});

	test("computes partial overlap correctly", () => {
		// intersection = {b}, union = {a, b, c}
		const score = jaccardSimilarity(["a", "b"], ["b", "c"]);
		expect(score).toBeCloseTo(1 / 3, 5);
	});
});

describe("collectFunctions", () => {
	test("collects function declarations", () => {
		const code = `
function add(a: number, b: number): number {
  const sum = a + b;
  const result = sum * 2;
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("add");
		expect(fns[0]?.file).toBe("test.ts");
		expect(fns[0]?.line).toBeGreaterThan(0);
	});

	test("collects exported function declarations", () => {
		const code = `
export function greet(name: string): string {
  const prefix = "Hello";
  const message = prefix + name;
  return message;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("greet");
	});

	test("collects const arrow functions with block body", () => {
		const code = `
const process = (items: string[]): string[] => {
  const result = items.filter(Boolean);
  const mapped = result.map(x => x.trim());
  return mapped;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("process");
	});

	test("collects const function expressions", () => {
		const code = `
const transform = function(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  return lower;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("transform");
	});

	test("skips trivially small functions (below token threshold)", () => {
		const code = `
function noop() {}
const id = (x: unknown) => x;
function tiny() { return 1; }
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// All three are too small (fewer than MIN_TOKEN_COUNT tokens after normalization)
		expect(fns).toHaveLength(0);
	});

	test("collects multiple functions", () => {
		const code = `
function alpha(x: number): number {
  const doubled = x * 2;
  const shifted = doubled + 10;
  return shifted;
}

const beta = (y: number): number => {
  const tripled = y * 3;
  const shifted = tripled + 10;
  return shifted;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(2);
		expect(fns.map((f) => f.name)).toEqual(["alpha", "beta"]);
	});

	test("skips arrow functions with expression body (not block)", () => {
		const code = `
const double = (x: number): number => x * 2;
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// Expression body, not a block — skipped
		expect(fns).toHaveLength(0);
	});

	test("does not collect nested functions", () => {
		// Only top-level statements are scanned
		const code = `
function outer(x: number): number {
  function inner(y: number): number {
    const val = y + 1;
    const res = val * 2;
    return res;
  }
  return inner(x);
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// Only outer is collected (top-level statement)
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("outer");
	});
});

describe("findSimilarGroups", () => {
	const filePath = "test.ts";

	function makeFunction(
		name: string,
		body: string,
		file = filePath
	): ReturnType<typeof collectFunctions>[number] {
		const sf = makeSourceFile(`function ${name}() ${body}`);
		const fns = collectFunctions(sf, file);
		const fn = fns[0];
		if (!fn) {
			// Force create when body is too small to be collected
			const normalized = normalizeBody(body);
			const tokens = tokenize(normalized);
			return {
				file,
				name,
				line: 1,
				column: 0,
				normalizedBody: normalized,
				tokenCount: tokens.length,
			};
		}
		return { ...fn, name };
	}

	test("groups exact duplicates (bucket=exact)", () => {
		// Two functions with identical structure but different variable names
		const bodyA = `{
  const date = input.toISOString();
  const formatted = date.split("T")[0];
  return formatted;
}`;
		const bodyB = `{
  const ts = value.toISOString();
  const result = ts.split("T")[0];
  return result;
}`;
		const fnA = makeFunction("formatDate", bodyA, "a.ts");
		const fnB = makeFunction("formatTimestamp", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.7);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.bucket).toBe("exact");
		expect(groups[0]?.score).toBeCloseTo(1.0, 3);
		expect(groups[0]?.functions.map((f) => f.name)).toEqual(
			expect.arrayContaining(["formatDate", "formatTimestamp"])
		);
	});

	test("groups loosely similar functions (bucket=high or medium)", () => {
		// Two functions with similar but not identical structure
		const bodyA = `{
  const items = list.filter(Boolean);
  const result = items.map(x => x.trim());
  return result;
}`;
		const bodyB = `{
  const items = collection.filter(Boolean);
  const result = items.map(x => x.toLowerCase());
  const final = result.join(",");
  return final;
}`;
		const fnA = makeFunction("processA", bodyA, "a.ts");
		const fnB = makeFunction("processB", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.5);
		expect(groups).toHaveLength(1);
		const g0 = groups[0];
		if (!g0) {
			throw new Error("Expected at least one group");
		}
		expect(["exact", "high", "medium"]).toContain(g0.bucket);
	});

	test("does not group dissimilar functions", () => {
		const bodyA = `{
  const x = a + b;
  const y = x * 2;
  return y;
}`;
		const bodyB = `{
  for (const item of list) {
    if (item.active) {
      results.push(item.name);
    }
  }
  return results;
}`;
		const fnA = makeFunction("add", bodyA, "a.ts");
		const fnB = makeFunction("collect", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.7);
		expect(groups).toHaveLength(0);
	});

	test("returns empty array when no functions provided", () => {
		expect(findSimilarGroups([], 0.7)).toHaveLength(0);
	});

	test("returns empty array for single function", () => {
		const fn = makeFunction(
			"solo",
			`{
  const x = compute(a, b);
  const y = transform(x);
  return y;
}`
		);
		expect(findSimilarGroups([fn], 0.7)).toHaveLength(0);
	});

	test("groups are sorted by score descending", () => {
		// Build FunctionInfo objects directly with controlled normalizedBody values
		// so that exact vs medium similarity is deterministic.

		// Exact pair: identical normalized body
		const exactBody =
			"{ const $I = $I.$I($I); const $I = $I.$I($S); return $I; }";
		const fnE1: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "exactA",
			line: 1,
			column: 0,
			normalizedBody: exactBody,
			tokenCount: tokenize(exactBody).length,
		};
		const fnE2: ReturnType<typeof collectFunctions>[number] = {
			file: "b.ts",
			name: "exactB",
			line: 1,
			column: 0,
			normalizedBody: exactBody,
			tokenCount: tokenize(exactBody).length,
		};

		// Medium pair: share most tokens but differ on one clause
		const looseBodyA =
			"{ for (const $I of $I) { if ($I.$I) { $I.$I($I.$I); } } return $I; }";
		const looseBodyB =
			"{ for (const $I of $I) { if ($I.$I) { $I.$I($I.$I); } $I++; } return $I; }";
		const fnL1: ReturnType<typeof collectFunctions>[number] = {
			file: "c.ts",
			name: "loopA",
			line: 1,
			column: 0,
			normalizedBody: looseBodyA,
			tokenCount: tokenize(looseBodyA).length,
		};
		const fnL2: ReturnType<typeof collectFunctions>[number] = {
			file: "d.ts",
			name: "loopB",
			line: 1,
			column: 0,
			normalizedBody: looseBodyB,
			tokenCount: tokenize(looseBodyB).length,
		};

		// Verify cross-pair similarity is below threshold 0.7 so groups stay separate
		const crossScore = jaccardSimilarity(
			tokenize(exactBody),
			tokenize(looseBodyA)
		);
		expect(crossScore).toBeLessThan(0.7);

		const groups = findSimilarGroups([fnE1, fnL1, fnE2, fnL2], 0.7);
		expect(groups.length).toBeGreaterThanOrEqual(1);
		// Groups should be sorted by score descending
		for (let i = 1; i < groups.length; i++) {
			const prev = groups[i - 1];
			const curr = groups[i];
			if (prev && curr) {
				expect(prev.score).toBeGreaterThanOrEqual(curr.score);
			}
		}
	});

	test("each function appears in at most one group", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("fetchA", body, "a.ts");
		const fn2 = makeFunction("fetchB", body, "b.ts");
		const fn3 = makeFunction("fetchC", body, "c.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3], 0.7);
		const allNames = groups.flatMap((g) => g.functions.map((f) => f.name));
		const uniqueNames = new Set(allNames);
		expect(uniqueNames.size).toBe(allNames.length);
	});
});
