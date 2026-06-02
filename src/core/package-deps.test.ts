import { describe, expect, test } from "bun:test";
import {
	applyDependencyAdditions,
	computeDependencyAdditions,
	computeInternalDependencyAdditions,
	serializePackageJson,
} from "./package-deps.ts";
import { packageNameFromSpecifier } from "./resolver.ts";

describe("packageNameFromSpecifier (#118)", () => {
	test("returns the bare name for an unscoped specifier", () => {
		expect(packageNameFromSpecifier("lodash")).toBe("lodash");
	});

	test("strips the subpath of an unscoped specifier", () => {
		expect(packageNameFromSpecifier("lodash/fp")).toBe("lodash");
	});

	test("keeps the scope+name for a scoped specifier", () => {
		expect(packageNameFromSpecifier("@scope/pkg")).toBe("@scope/pkg");
	});

	test("strips the subpath of a scoped specifier", () => {
		expect(packageNameFromSpecifier("@scope/pkg/sub")).toBe("@scope/pkg");
	});

	test("returns null for relative and absolute specifiers", () => {
		expect(packageNameFromSpecifier("./foo")).toBeNull();
		expect(packageNameFromSpecifier("../foo")).toBeNull();
		expect(packageNameFromSpecifier("/abs/foo")).toBeNull();
	});
});

describe("computeDependencyAdditions (#118)", () => {
	test("copies a missing external dep's range from the source", () => {
		const additions = computeDependencyAdditions(
			["lodash"],
			{ dependencies: { lodash: "^4.17.0" } },
			{ dependencies: {} }
		);
		expect(additions).toEqual([
			{ name: "lodash", version: "^4.17.0", field: "dependencies" },
		]);
	});

	test("mirrors peerDependencies placement from the source", () => {
		const additions = computeDependencyAdditions(
			["react"],
			{ peerDependencies: { react: ">=18" } },
			{ dependencies: {} }
		);
		expect(additions).toEqual([
			{ name: "react", version: ">=18", field: "peerDependencies" },
		]);
	});

	test("prefers dependencies when the source declares both", () => {
		const additions = computeDependencyAdditions(
			["react"],
			{
				dependencies: { react: "^18.0.0" },
				peerDependencies: { react: ">=18" },
			},
			{}
		);
		expect(additions).toEqual([
			{ name: "react", version: "^18.0.0", field: "dependencies" },
		]);
	});

	test("never duplicates a dep already in the destination dependencies", () => {
		const additions = computeDependencyAdditions(
			["lodash"],
			{ dependencies: { lodash: "^4.17.0" } },
			{ dependencies: { lodash: "^4.0.0" } }
		);
		expect(additions).toEqual([]);
	});

	test("treats a dep present only in destination peerDependencies as present", () => {
		const additions = computeDependencyAdditions(
			["react"],
			{ dependencies: { react: "^18.0.0" } },
			{ peerDependencies: { react: ">=17" } }
		);
		expect(additions).toEqual([]);
	});

	test("carries a workspace:* range over verbatim", () => {
		const additions = computeDependencyAdditions(
			["@scope/core"],
			{ dependencies: { "@scope/core": "workspace:*" } },
			{}
		);
		expect(additions).toEqual([
			{ name: "@scope/core", version: "workspace:*", field: "dependencies" },
		]);
	});

	test("skips names the source package does not declare", () => {
		const additions = computeDependencyAdditions(
			["left-pad"],
			{ dependencies: { lodash: "^4.17.0" } },
			{}
		);
		expect(additions).toEqual([]);
	});

	test("deduplicates repeated names", () => {
		const additions = computeDependencyAdditions(
			["lodash", "lodash"],
			{ dependencies: { lodash: "^4.17.0" } },
			{}
		);
		expect(additions).toHaveLength(1);
	});
});

describe("computeInternalDependencyAdditions (#119)", () => {
	test("adds a missing internal dep as workspace:*", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/core"],
			{ dependencies: { "@scope/core": "workspace:*" } },
			{}
		);
		expect(additions).toEqual([
			{ name: "@scope/core", version: "workspace:*", field: "dependencies" },
		]);
	});

	test("uses workspace:* even when the source declares a semver range", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/core"],
			{ dependencies: { "@scope/core": "^1.2.3" } },
			{}
		);
		expect(additions).toEqual([
			{ name: "@scope/core", version: "workspace:*", field: "dependencies" },
		]);
	});

	test("adds workspace:* even when the source does not declare the dep", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/core"],
			{ dependencies: { lodash: "^4.17.0" } },
			{}
		);
		expect(additions).toEqual([
			{ name: "@scope/core", version: "workspace:*", field: "dependencies" },
		]);
	});

	test("mirrors peerDependencies placement from the source", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/ui"],
			{ peerDependencies: { "@scope/ui": "workspace:*" } },
			{}
		);
		expect(additions).toEqual([
			{ name: "@scope/ui", version: "workspace:*", field: "peerDependencies" },
		]);
	});

	test("never duplicates or downgrades an existing destination entry", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/core", "@scope/ui"],
			{ dependencies: { "@scope/core": "workspace:*" } },
			{
				dependencies: { "@scope/core": "workspace:^" },
				peerDependencies: { "@scope/ui": "workspace:*" },
			}
		);
		expect(additions).toEqual([]);
	});

	test("deduplicates repeated names", () => {
		const additions = computeInternalDependencyAdditions(
			["@scope/core", "@scope/core"],
			{},
			{}
		);
		expect(additions).toHaveLength(1);
	});
});

describe("applyDependencyAdditions (#118)", () => {
	test("adds and alphabetically sorts the touched field", () => {
		const result = applyDependencyAdditions(
			{ name: "pkg", dependencies: { zebra: "^1.0.0" } },
			[
				{ name: "lodash", version: "^4.17.0", field: "dependencies" },
				{ name: "axios", version: "^1.0.0", field: "dependencies" },
			]
		);
		expect(Object.keys(result.dependencies as Record<string, string>)).toEqual([
			"axios",
			"lodash",
			"zebra",
		]);
	});

	test("creates the field when the destination lacks it", () => {
		const result = applyDependencyAdditions({ name: "pkg" }, [
			{ name: "react", version: ">=18", field: "peerDependencies" },
		]);
		expect(result.peerDependencies).toEqual({ react: ">=18" });
	});

	test("never overwrites an existing entry", () => {
		const result = applyDependencyAdditions(
			{ dependencies: { lodash: "^4.0.0" } },
			[{ name: "lodash", version: "^9.9.9", field: "dependencies" }]
		);
		expect((result.dependencies as Record<string, string>).lodash).toBe(
			"^4.0.0"
		);
	});

	test("preserves unrelated fields and returns the input when empty", () => {
		const input = { name: "pkg", version: "1.0.0" };
		expect(applyDependencyAdditions(input, [])).toBe(input);
	});
});

describe("serializePackageJson (#118)", () => {
	test("uses 2-space indent and a trailing newline", () => {
		const out = serializePackageJson({ name: "pkg" });
		expect(out).toBe('{\n  "name": "pkg"\n}\n');
	});
});
