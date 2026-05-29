import { describe, expect, test } from "bun:test";
import {
	compareDeclarations,
	DUPLICATE_DECLARATION_THRESHOLD,
	describeComparison,
} from "./duplicate-detection.ts";
import { createSourceFileFromText } from "./source-file.ts";

const DUPLICATE_BODY = `
export function formatUser(user: { first: string; last: string }) {
	const full = user.first + " " + user.last;
	const trimmed = full.trim();
	return trimmed.toUpperCase();
}
`;

const NEAR_DUPLICATE_BODY = `
export function formatUser(person: { first: string; last: string }) {
	const whole = person.first + " " + person.last;
	const clean = whole.trim();
	return clean.toUpperCase();
}
`;

const UNRELATED_BODY = `
export function formatUser(items: number[]) {
	let total = 0;
	for (const value of items) {
		total += value * value;
	}
	return Math.sqrt(total);
}
`;

describe("compareDeclarations", () => {
	test("flags structurally identical same-named declarations as duplicates", () => {
		const incoming = createSourceFileFromText("incoming.ts", DUPLICATE_BODY);
		const existing = createSourceFileFromText(
			"existing.ts",
			NEAR_DUPLICATE_BODY
		);

		const result = compareDeclarations(
			incoming,
			"formatUser",
			existing,
			"formatUser"
		);

		expect(result.comparable).toBe(true);
		expect(result.isDuplicate).toBe(true);
		expect(result.similarity).toBeGreaterThanOrEqual(
			DUPLICATE_DECLARATION_THRESHOLD
		);
	});

	test("does not flag same-named but unrelated declarations", () => {
		const incoming = createSourceFileFromText("incoming.ts", DUPLICATE_BODY);
		const existing = createSourceFileFromText("existing.ts", UNRELATED_BODY);

		const result = compareDeclarations(
			incoming,
			"formatUser",
			existing,
			"formatUser"
		);

		expect(result.isDuplicate).toBe(false);
	});

	test("reports not comparable when a declaration is missing", () => {
		const incoming = createSourceFileFromText("incoming.ts", DUPLICATE_BODY);
		const existing = createSourceFileFromText(
			"existing.ts",
			"export const x = 1;"
		);

		const result = compareDeclarations(
			incoming,
			"formatUser",
			existing,
			"formatUser"
		);

		expect(result.comparable).toBe(false);
		expect(result.isDuplicate).toBe(false);
	});

	test("compares two differently-named declarations within one file", () => {
		const file = createSourceFileFromText(
			"both.ts",
			`${DUPLICATE_BODY.replace("formatUser", "formatUserA")}\n${NEAR_DUPLICATE_BODY.replace("formatUser", "formatUserB")}`
		);

		const result = compareDeclarations(
			file,
			"formatUserA",
			file,
			"formatUserB"
		);

		expect(result.comparable).toBe(true);
		expect(result.isDuplicate).toBe(true);
	});

	test("does not compare a declaration with itself", () => {
		const file = createSourceFileFromText("self.ts", DUPLICATE_BODY);

		const result = compareDeclarations(file, "formatUser", file, "formatUser");

		expect(result.comparable).toBe(false);
	});
});

describe("describeComparison", () => {
	test("returns empty string when not comparable", () => {
		expect(
			describeComparison({
				comparable: false,
				similarity: 0,
				isDuplicate: false,
			})
		).toBe("");
	});

	test("calls out a duplicate with its percentage", () => {
		const text = describeComparison({
			comparable: true,
			similarity: 0.93,
			isDuplicate: true,
		});
		expect(text).toContain("duplicate");
		expect(text).toContain("93%");
	});
});
