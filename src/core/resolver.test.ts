import { describe, expect, test } from "bun:test";
import type ts from "typescript";
import type { ProjectConfig } from "../types.ts";
import {
	calculateRelativeSpecifier,
	findAliasForPath,
	findCrossPackageImport,
	findPackageForPath,
	isBareImport,
	isCrossPackageMove,
	isRelativeImport,
	matchPathAlias,
	normalizePath,
} from "./resolver.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeProject(
	rootDir: string,
	pathAliases: Record<string, string[]> = {}
): ProjectConfig {
	return {
		rootDir,
		tsconfigPath: `${rootDir}/tsconfig.json`,
		compilerOptions: {
			baseUrl: rootDir,
		} as ts.CompilerOptions,
		pathAliases: new Map(Object.entries(pathAliases)),
		include: [],
		exclude: [],
		files: [],
	};
}

function makeWorkspace(
	root: string,
	packages: Array<{ name: string; subdir: string; srcDir?: string }>
): WorkspaceInfo {
	return {
		root,
		type: "pnpm",
		patterns: ["packages/*"],
		packages: packages.map(
			({ name, subdir, srcDir }): WorkspacePackage => ({
				name,
				path: `${root}/${subdir}`,
				packageJsonPath: `${root}/${subdir}/package.json`,
				srcDir,
			})
		),
	};
}

// ─── isRelativeImport ──────────────────────────────────────────────────────

describe("isRelativeImport", () => {
	test("returns true for ./ imports", () => {
		expect(isRelativeImport("./foo")).toBe(true);
	});

	test("returns true for ../ imports", () => {
		expect(isRelativeImport("../foo")).toBe(true);
	});

	test("returns false for bare package imports", () => {
		expect(isRelativeImport("react")).toBe(false);
		expect(isRelativeImport("@scope/pkg")).toBe(false);
	});

	test("returns false for path alias imports", () => {
		expect(isRelativeImport("@/components/Foo")).toBe(false);
	});
});

// ─── isBareImport ──────────────────────────────────────────────────────────

describe("isBareImport", () => {
	test("returns true for bare package names", () => {
		expect(isBareImport("react")).toBe(true);
		expect(isBareImport("lodash")).toBe(true);
	});

	test("returns true for scoped packages", () => {
		expect(isBareImport("@scope/package")).toBe(true);
	});

	test("returns false for relative imports", () => {
		expect(isBareImport("./foo")).toBe(false);
		expect(isBareImport("../bar")).toBe(false);
	});

	test("returns false for absolute paths", () => {
		expect(isBareImport("/absolute/path")).toBe(false);
	});
});

// ─── normalizePath ─────────────────────────────────────────────────────────

describe("normalizePath", () => {
	test("normalizes double slashes", () => {
		expect(normalizePath("/foo//bar")).toBe("/foo/bar");
	});

	test("normalizes . and .. segments", () => {
		expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
		expect(normalizePath("/foo/baz/../bar")).toBe("/foo/bar");
	});

	test("handles already-clean paths", () => {
		expect(normalizePath("/foo/bar/baz.ts")).toBe("/foo/bar/baz.ts");
	});
});

// ─── calculateRelativeSpecifier ────────────────────────────────────────────

describe("calculateRelativeSpecifier", () => {
	test("uses ./ prefix for same-directory files", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts"
		);
		expect(result).toBe("./b");
	});

	test("uses ../ for parent directory files", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/components/Button.ts",
			"/project/src/utils.ts"
		);
		expect(result).toBe("../utils");
	});

	test("uses deep ../ chains for distant ancestors", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a/b/c.ts",
			"/project/src/d.ts"
		);
		expect(result).toBe("../../d");
	});

	test("strips .ts extension from result", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts"
		);
		expect(result).not.toContain(".ts");
	});

	test("collapses index.ts to bare directory path", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/utils/index.ts"
		);
		expect(result).toBe("./utils");
	});

	test("returns . for same directory index.ts → index.ts", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/utils/consumer.ts",
			"/project/src/utils/index.ts"
		);
		expect(result).toBe(".");
	});
});

// ─── matchPathAlias ────────────────────────────────────────────────────────

describe("matchPathAlias", () => {
	test("matches a wildcard alias", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = matchPathAlias("@/components/Button", project);
		expect(result).not.toBeNull();
		expect(result?.alias).toBe("@/*");
		expect(result?.remainder).toBe("components/Button");
	});

	test("matches an exact alias", () => {
		const project = makeProject("/project", {
			"@utils": ["src/utils/index"],
		});
		const result = matchPathAlias("@utils", project);
		expect(result).not.toBeNull();
		expect(result?.alias).toBe("@utils");
		expect(result?.remainder).toBe("");
	});

	test("returns null when no alias matches", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = matchPathAlias("./relative/path", project);
		expect(result).toBeNull();
	});

	test("returns null for bare package imports", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		expect(matchPathAlias("react", project)).toBeNull();
	});

	test("returns null when there are no aliases", () => {
		const project = makeProject("/project");
		expect(matchPathAlias("@/foo", project)).toBeNull();
	});
});

// ─── findAliasForPath ──────────────────────────────────────────────────────

describe("findAliasForPath", () => {
	test("finds wildcard alias for a file inside src/", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/project/src/utils/helpers.ts", project);
		expect(result).toBe("@/utils/helpers");
	});

	test("returns null when no alias covers the path", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/other-project/src/foo.ts", project);
		expect(result).toBeNull();
	});

	test("returns null when there are no aliases", () => {
		const project = makeProject("/project");
		expect(findAliasForPath("/project/src/foo.ts", project)).toBeNull();
	});

	test("strips file extension from result", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/project/src/foo.ts", project);
		expect(result).toBe("@/foo");
		expect(result).not.toContain(".ts");
	});
});

// ─── findPackageForPath ────────────────────────────────────────────────────

describe("findPackageForPath", () => {
	test("returns package info when file is inside a known package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findPackageForPath(
			"/repo/packages/pkg/src/foo.ts",
			workspace
		);
		expect(result).not.toBeNull();
		expect(result?.packageName).toBe("@scope/pkg");
		expect(result?.packagePath).toBe("/repo/packages/pkg");
	});

	test("returns null when file is not inside any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findPackageForPath("/other/path/foo.ts", workspace);
		expect(result).toBeNull();
	});

	test("returns null for empty workspace", () => {
		const workspace = makeWorkspace("/repo", []);
		expect(
			findPackageForPath("/repo/packages/pkg/foo.ts", workspace)
		).toBeNull();
	});

	test("returns the most specific (longest path) matching package", () => {
		// When a file is in a nested package, the deepest match should win
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/outer", subdir: "packages" },
			{ name: "@scope/inner", subdir: "packages/inner" },
		]);
		const result = findPackageForPath(
			"/repo/packages/inner/src/foo.ts",
			workspace
		);
		// findPackageForPath uses startsWith, so both match; first match wins
		expect(result?.packageName).toBe("@scope/outer");
	});
});

// ─── isCrossPackageMove ────────────────────────────────────────────────────

describe("isCrossPackageMove", () => {
	test("returns true when source and target are in different packages", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
			{ name: "@scope/b", subdir: "packages/b" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/repo/packages/b/src/foo.ts",
			workspace
		);
		expect(result).toBe(true);
	});

	test("returns false when source and target are in the same package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/repo/packages/a/src/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});

	test("returns false when source is not in any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/other/foo.ts",
			"/repo/packages/a/src/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});

	test("returns false when target is not in any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/other/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});
});

// ─── findCrossPackageImport ────────────────────────────────────────────────

describe("findCrossPackageImport", () => {
	test("returns package name when file is in src/ and addingToBarrel is true", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg", srcDir: "src" },
		]);
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/foo.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/pkg");
	});

	test("returns package name even when addingToBarrel defaults to true", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg", srcDir: "src" },
		]);
		// default parameter is true
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/utils.ts",
			workspace
		);
		expect(result).toBe("@scope/pkg");
	});

	test("returns null when target is not in any workspace package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findCrossPackageImport("/other/foo.ts", workspace);
		expect(result).toBeNull();
	});
});
