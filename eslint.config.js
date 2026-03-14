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
