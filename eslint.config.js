import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/**", "dist/**", "bin/**"],
	},
	{
		files: ["src/**/*.ts"],
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Strict async/promise rules — these are the core purpose of this config
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/promise-function-async": "error",
			"@typescript-eslint/return-await": ["error", "in-try-catch"],

			// Correctness + clarity rules beyond recommendedTypeChecked.
			// no-unnecessary-condition note: TS types `ts.Node.parent` as
			// non-nullable, but it is `undefined` at the SourceFile root and in
			// unbound trees (see CLAUDE.md). Defensive parent checks therefore go
			// through `parentOf()` (typed `ts.Node | undefined`) so the guard is
			// genuinely necessary and keeps its runtime crash protection.
			"@typescript-eslint/switch-exhaustiveness-check": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/prefer-optional-chain": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/no-unnecessary-type-arguments": "error",
			"@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
			"@typescript-eslint/no-confusing-void-expression": "error",

			// Turn off no-unsafe-* — TypeScript Compiler API uses untyped internals
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-argument": "off",

			// Handled by Biome or too noisy
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
		},
	}
);
