import type ts from "typescript";
import { collectFunctions, findSimilarGroups } from "./similarity.ts";

/**
 * Score at or above which two declarations are treated as "essentially
 * duplicates". Tuned to the `high` similarity bucket (see `scoreToBucket` in
 * similarity.ts) so that near-identical bodies trip the guard while merely
 * structurally similar declarations do not.
 */
export const DUPLICATE_DECLARATION_THRESHOLD = 0.85;

/**
 * Floor passed to `findSimilarGroups`. Declarations only form a group (and thus
 * yield a score) at or above the `medium` bucket (0.7). Anything below that is
 * reported as `similarity: 0` — well clear of the duplicate threshold.
 */
const GROUPING_FLOOR = 0.7;

export interface DeclarationComparison {
	/** Both declarations were found and are of a kind the scorer can compare. */
	comparable: boolean;
	/**
	 * Similarity 0–1 between the two declaration bodies. 0 when the pair is not
	 * comparable or scored below the grouping floor.
	 */
	similarity: number;
	/** True when comparable and similarity >= DUPLICATE_DECLARATION_THRESHOLD. */
	isDuplicate: boolean;
}

const NOT_COMPARABLE: DeclarationComparison = {
	comparable: false,
	similarity: 0,
	isDuplicate: false,
};

/**
 * Compare the body of declaration `nameA` in `fileA` against declaration
 * `nameB` in `fileB`, reusing the tuned similarity scoring from the `similar`
 * command (`collectFunctions` + `findSimilarGroups`). Pass the same source file
 * for both when comparing two declarations within one file (e.g. a rename whose
 * target name already exists locally).
 *
 * Only declarations `collectFunctions` can represent are comparable: function
 * declarations, const arrow/function expressions, type aliases, and interfaces
 * with enough tokens. Classes, enums, and tiny bodies are not comparable and
 * return `{ comparable: false }` — callers still surface the raw name clash.
 */
export function compareDeclarations(
	fileA: ts.SourceFile,
	nameA: string,
	fileB: ts.SourceFile,
	nameB: string
): DeclarationComparison {
	const fnsA = collectFunctions(fileA, fileA.fileName);
	// Reuse the same scan when both declarations live in one source file.
	const fnsB = fileB === fileA ? fnsA : collectFunctions(fileB, fileB.fileName);

	const declA = fnsA.find((f) => f.name === nameA);
	const declB = fnsB.find((f) => f.name === nameB);
	if (!(declA && declB)) {
		return NOT_COMPARABLE;
	}

	// Comparing a declaration with itself (same file, same name) is meaningless.
	if (declA === declB) {
		return NOT_COMPARABLE;
	}

	const groups = findSimilarGroups([declA, declB], GROUPING_FLOOR);
	const similarity = groups[0]?.score ?? 0;
	return {
		comparable: true,
		similarity,
		isDuplicate: similarity >= DUPLICATE_DECLARATION_THRESHOLD,
	};
}

/**
 * Human-readable suffix describing a comparison, for appending to a conflict
 * message. Empty string when the declarations are not comparable.
 */
export function describeComparison(comparison: DeclarationComparison): string {
	if (!comparison.comparable) {
		return "";
	}
	const pct = Math.round(comparison.similarity * 100);
	if (comparison.isDuplicate) {
		return ` — the existing declaration is essentially a duplicate (${pct}% similar)`;
	}
	if (comparison.similarity > 0) {
		return ` — the existing declaration is ${pct}% similar`;
	}
	return " — the existing declaration looks unrelated";
}
