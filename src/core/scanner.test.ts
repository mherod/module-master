import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { ProjectConfig } from "../types";
import { scanModuleReferences, withSourceFile } from "./scanner";

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

describe("withSourceFile", () => {
	test("runs the callback for a readable file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-scanner-"));
		const filePath = path.join(dir, "sample.ts");
		await Bun.write(filePath, "export const value = 1;\n");

		try {
			const statementCount = withSourceFile(
				filePath,
				(sourceFile) => sourceFile.statements.length,
				-1
			);

			expect(statementCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns the fallback when the file cannot be read", () => {
		const statementCount = withSourceFile(
			"/tmp/resect-missing-source-file.ts",
			(sourceFile) => sourceFile.statements.length,
			-1
		);

		expect(statementCount).toBe(-1);
	});
	test("runs the callback for a source file already loaded in a program", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-program-"));
		const filePath = path.join(dir, "program-source.ts");
		await Bun.write(filePath, "export const loaded = true;\n");

		try {
			const program = ts.createProgram([filePath], {
				target: ts.ScriptTarget.ES2020,
			});
			const statementCount = withSourceFile(
				program,
				filePath,
				(sourceFile) => sourceFile.statements.length,
				-1
			);

			expect(statementCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns the fallback when the program has no matching source file", () => {
		const program = ts.createProgram([], {
			target: ts.ScriptTarget.ES2020,
		});
		const statementCount = withSourceFile(
			program,
			"/tmp/resect-missing-program-source.ts",
			(sourceFile) => sourceFile.statements.length,
			-1
		);

		expect(statementCount).toBe(-1);
	});
});
