import { describe, expect, mock, test } from "bun:test";
import ts from "typescript";
import type { ProjectConfig } from "../types";
import { scanModuleReferences } from "./scanner";

// Mock resolver to avoid file system lookups
await mock.module("./resolver", () => {
	return {
		resolveModuleSpecifier: (specifier: string) => ({
			kind: "resolved",
			path: `/resolved/${specifier}`,
		}),
	};
});

describe("scanModuleReferences", () => {
	const project = {
		compilerOptions: {},
		pathAliases: new Map(),
		rootDir: "/",
		tsconfigPath: "/tsconfig.json",
	} as ProjectConfig;

	test("scans jest.mock calls", () => {
		const sourceCode = `
            import { something } from './local';
            jest.mock('./mocked');
            vi.mock('./vi-mocked');
			vitest.mock('./vitest-mocked');
        `;
		const sourceFile = ts.createSourceFile(
			"test.ts",
			sourceCode,
			ts.ScriptTarget.Latest
		);
		const refs = scanModuleReferences(sourceFile, project);

		expect(refs).toContainEqual(
			expect.objectContaining({ specifier: "./mocked", type: "jest-mock" })
		);
		expect(refs).toContainEqual(
			expect.objectContaining({ specifier: "./vi-mocked", type: "jest-mock" })
		);
		expect(refs).toContainEqual(
			expect.objectContaining({
				specifier: "./vitest-mocked",
				type: "jest-mock",
			})
		);
	});
});
