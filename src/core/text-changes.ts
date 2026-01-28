/**
 * Represents a text change to be applied to a source file
 */
export interface TextChange {
	/** Start position in the source text */
	start: number;
	/** End position in the source text */
	end: number;
	/** New text to insert at this position */
	newText: string;
}

/**
 * Apply text changes to source content.
 * Changes are sorted in reverse order and applied from end to start
 * to preserve position accuracy.
 *
 * @param content - The original source content
 * @param changes - Array of text changes to apply
 * @returns The modified content with all changes applied
 */
export function applyTextChanges(
	content: string,
	changes: TextChange[]
): string {
	if (changes.length === 0) {
		return content;
	}

	// Sort changes by position descending to maintain accurate positions
	const sorted = [...changes].sort((a, b) => b.start - a.start);

	let result = content;
	for (const change of sorted) {
		result =
			result.slice(0, change.start) + change.newText + result.slice(change.end);
	}

	return result;
}

/**
 * Deduplicate changes by position (same start-end range)
 *
 * @param changes - Array of text changes that may contain duplicates
 * @returns Array with duplicate positions removed (keeps first occurrence)
 */
export function deduplicateChanges(changes: TextChange[]): TextChange[] {
	const seen = new Set<string>();
	return changes.filter((change) => {
		const key = `${change.start}-${change.end}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
