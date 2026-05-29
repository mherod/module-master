/**
 * Vue Single-File Component (SFC) script block extraction.
 *
 * Extracts TypeScript or JavaScript content from <script> and
 * <script setup> blocks without requiring the Vue template compiler.
 */

interface VueSfcScript {
	/** The raw script block content (TypeScript or JavaScript) */
	content: string;
	/** Language declared in the lang attribute (defaults to "ts") */
	lang: "ts" | "js";
	/** Whether this is a <script setup> Composition API block */
	isSetup: boolean;
	/** Character offset of content start within the original .vue source */
	offset: number;
}

const SCRIPT_BLOCK_PATTERN = /<script(\s[^>]*)?\s*>([\s\S]*?)<\/script>/gi;

/**
 * Extract the script block from a Vue SFC source string.
 *
 * Prefers <script setup> (Composition API) over plain <script> (Options API)
 * when both are present. Returns null when no script block is found.
 *
 * Handles common Vue SFC patterns:
 *   <script lang="ts" setup>...</script>
 *   <script setup lang="ts">...</script>
 *   <script lang="ts">...</script>
 *   <script>...</script>
 */
export function extractVueScript(source: string): VueSfcScript | null {
	let fallback: VueSfcScript | null = null;

	for (const match of source.matchAll(SCRIPT_BLOCK_PATTERN)) {
		const attrs = match[1] ?? "";
		const content = match[2] ?? "";
		const isSetup = /\bsetup\b/i.test(attrs);
		const langMatch = /\blang=["']?(ts|js)["']?/i.exec(attrs);
		const lang: "ts" | "js" =
			langMatch?.[1]?.toLowerCase() === "js" ? "js" : "ts";

		// Offset: position of content start in original source.
		// The opening tag closes at the first ">" in the full match string.
		const openTagLen = match[0].indexOf(">") + 1;
		const offset = match.index + openTagLen;

		const block: VueSfcScript = { content, lang, isSetup, offset };

		// <script setup> takes priority; return immediately
		if (isSetup) {
			return block;
		}
		fallback ??= block;
	}

	return fallback;
}
