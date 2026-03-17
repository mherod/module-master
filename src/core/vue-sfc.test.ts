import { describe, expect, test } from "bun:test";
import { extractVueScript } from "./vue-sfc.ts";

describe("extractVueScript", () => {
	describe("Options API (<script> block)", () => {
		const optionsApiSfc = `<template>
  <div>{{ message }}</div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'MyComponent',
  data() {
    return { message: 'hello' };
  },
});
</script>
`;

		test("extracts script content", () => {
			const result = extractVueScript(optionsApiSfc);
			expect(result).not.toBeNull();
			expect(result?.content).toContain("defineComponent");
			expect(result?.content).toContain("MyComponent");
		});

		test("detects lang=ts", () => {
			const result = extractVueScript(optionsApiSfc);
			expect(result?.lang).toBe("ts");
		});

		test("isSetup is false for plain <script>", () => {
			const result = extractVueScript(optionsApiSfc);
			expect(result?.isSetup).toBe(false);
		});

		test("offset points into script content (not the opening tag)", () => {
			const result = extractVueScript(optionsApiSfc);
			expect(result).not.toBeNull();
			// offset should land inside the content, not at the <script> tag itself
			const contentAtOffset = optionsApiSfc.slice(result?.offset);
			expect(contentAtOffset.startsWith(result?.content ?? "")).toBe(true);
		});
	});

	describe("Composition API (<script setup> block)", () => {
		const compositionApiSfc = `<template>
  <button @click="count++">{{ count }}</button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const count = ref(0);
const router = useRouter();
</script>
`;

		test("extracts script content", () => {
			const result = extractVueScript(compositionApiSfc);
			expect(result).not.toBeNull();
			expect(result?.content).toContain("ref");
			expect(result?.content).toContain("useRouter");
		});

		test("detects lang=ts", () => {
			const result = extractVueScript(compositionApiSfc);
			expect(result?.lang).toBe("ts");
		});

		test("isSetup is true for <script setup>", () => {
			const result = extractVueScript(compositionApiSfc);
			expect(result?.isSetup).toBe(true);
		});
	});

	describe("setup priority", () => {
		const bothBlocksSfc = `<template><div /></template>

<script lang="ts">
export default { name: 'Old' };
</script>

<script setup lang="ts">
import { ref } from 'vue';
const x = ref(0);
</script>
`;

		test("prefers <script setup> over plain <script>", () => {
			const result = extractVueScript(bothBlocksSfc);
			expect(result?.isSetup).toBe(true);
			expect(result?.content).toContain("const x = ref(0)");
			expect(result?.content).not.toContain("Old");
		});
	});

	describe("language detection", () => {
		test("defaults to ts when no lang attribute", () => {
			const sfc = "<script>\nexport default {};\n</script>";
			const result = extractVueScript(sfc);
			expect(result?.lang).toBe("ts");
		});

		test("detects lang=js", () => {
			const sfc = `<script lang="js">\nexport default {};\n</script>`;
			const result = extractVueScript(sfc);
			expect(result?.lang).toBe("js");
		});

		test("handles lang attribute before setup attribute", () => {
			const sfc = `<script lang="ts" setup>\nconst x = 1;\n</script>`;
			const result = extractVueScript(sfc);
			expect(result?.lang).toBe("ts");
			expect(result?.isSetup).toBe(true);
		});

		test("handles setup attribute before lang attribute", () => {
			const sfc = `<script setup lang="ts">\nconst x = 1;\n</script>`;
			const result = extractVueScript(sfc);
			expect(result?.lang).toBe("ts");
			expect(result?.isSetup).toBe(true);
		});
	});

	describe("no script block", () => {
		test("returns null for template-only SFC", () => {
			const sfc = "<template><div>hello</div></template>";
			expect(extractVueScript(sfc)).toBeNull();
		});

		test("returns null for empty string", () => {
			expect(extractVueScript("")).toBeNull();
		});
	});
});
