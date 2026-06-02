import type { DependencyChange, DependencyField } from "../types/move.ts";
import type { WorkspacePackage } from "./workspace.ts";

/** A dependency addition before its destination package.json path is known. */
export type DependencyAddition = Omit<DependencyChange, "packageJsonPath">;

/** The dependency-bearing subset of a package's parsed metadata. */
type DependencySource = Pick<
	WorkspacePackage,
	"dependencies" | "peerDependencies"
>;

/**
 * Compute the dependency entries missing from the destination package that
 * should be copied from the source package, for the given external package
 * names (issue #118 — external-dependency sync on cross-package move).
 *
 * - Copies the source package's version range verbatim (so a source
 *   `workspace:*` range is carried over unchanged).
 * - Mirrors the source's `dependencies` vs `peerDependencies` placement;
 *   prefers `dependencies` when a name appears in both.
 * - Never duplicates or downgrades a dep already present in the destination
 *   (checked against both `dependencies` and `peerDependencies`).
 * - Skips names the source package does not declare — there is no range to
 *   copy. (Internal workspace packages absent from the source are #119's job.)
 */
export function computeDependencyAdditions(
	externalPackageNames: string[],
	source: DependencySource,
	destination: DependencySource
): DependencyAddition[] {
	const additions: DependencyAddition[] = [];
	const destinationHas = (name: string): boolean =>
		destination.dependencies?.[name] !== undefined ||
		destination.peerDependencies?.[name] !== undefined;

	const seen = new Set<string>();
	for (const name of externalPackageNames) {
		if (seen.has(name) || destinationHas(name)) {
			continue;
		}
		const depVersion = source.dependencies?.[name];
		const peerVersion = source.peerDependencies?.[name];
		if (depVersion !== undefined) {
			additions.push({ name, version: depVersion, field: "dependencies" });
			seen.add(name);
		} else if (peerVersion !== undefined) {
			additions.push({ name, version: peerVersion, field: "peerDependencies" });
			seen.add(name);
		}
	}

	return additions;
}

/** The workspace-protocol range internal monorepo deps are declared with. */
const WORKSPACE_PROTOCOL_RANGE = "workspace:*";

/**
 * Compute the internal (monorepo) dependency entries missing from the
 * destination package, for collected specifiers that match a workspace
 * package name (issue #119 — internal-dependency sync on cross-package move).
 *
 * - Adds each missing internal dep as `workspace:*` rather than copying a
 *   semver range: the destination resolves siblings through the workspace, so
 *   a phantom semver range would be wrong even when the source declared one.
 * - Mirrors the source's `dependencies` vs `peerDependencies` placement when
 *   the source declares the dep; defaults to `dependencies` otherwise.
 * - Never duplicates, downgrades, or clobbers an existing destination entry
 *   (checked against both `dependencies` and `peerDependencies`), so an
 *   existing `workspace:^`-style protocol is left untouched.
 *
 * Callers must exclude the destination package's own name — a package never
 * depends on itself.
 */
export function computeInternalDependencyAdditions(
	internalPackageNames: string[],
	source: DependencySource,
	destination: DependencySource
): DependencyAddition[] {
	const additions: DependencyAddition[] = [];
	const destinationHas = (name: string): boolean =>
		destination.dependencies?.[name] !== undefined ||
		destination.peerDependencies?.[name] !== undefined;

	const seen = new Set<string>();
	for (const name of internalPackageNames) {
		if (seen.has(name) || destinationHas(name)) {
			continue;
		}
		let field: DependencyField = "dependencies";
		if (
			source.dependencies?.[name] === undefined &&
			source.peerDependencies?.[name] !== undefined
		) {
			field = "peerDependencies";
		}
		additions.push({ name, version: WORKSPACE_PROTOCOL_RANGE, field });
		seen.add(name);
	}

	return additions;
}

/**
 * Read the destination package's `restrictedDependencies` policy (issue #120)
 * off its parsed package.json. The policy is a flat array of exact package
 * names a cross-package move may not pull into this package. Returns the
 * sanitised string entries; a missing or malformed field yields an empty list,
 * so absence of a policy means no new blocking (back-compat with plain moves).
 */
export function normalizeRestrictedDependencies(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Filter the would-be dependency additions of a cross-package move down to the
 * ones the destination package forbids via `restrictedDependencies` (issue
 * #120 — restricted-dependency guardrail). An exact name match against the
 * policy set is a violation; an empty policy yields no violations. Pure and
 * read-only — it reads off the additions A(#118)/B(#119) already computed.
 */
export function computeRestrictedViolations(
	additions: DependencyAddition[],
	restrictedDependencies: string[]
): DependencyAddition[] {
	if (restrictedDependencies.length === 0) {
		return [];
	}
	const restricted = new Set(restrictedDependencies);
	return additions.filter((addition) => restricted.has(addition.name));
}

/**
 * Apply dependency additions to a parsed package.json object, returning a new
 * object. The touched fields are sorted alphabetically for deterministic diffs
 * (matching the convention most package managers normalize to). Existing
 * entries are preserved; additions never overwrite an existing key.
 */
export function applyDependencyAdditions(
	packageJson: Record<string, unknown>,
	additions: DependencyAddition[]
): Record<string, unknown> {
	if (additions.length === 0) {
		return packageJson;
	}

	const next: Record<string, unknown> = { ...packageJson };
	const touched = new Set<DependencyField>();

	for (const { name, version, field } of additions) {
		const current = (next[field] as Record<string, string> | undefined) ?? {};
		if (current[name] !== undefined) {
			continue; // never overwrite an existing entry
		}
		next[field] = { ...current, [name]: version };
		touched.add(field);
	}

	for (const field of touched) {
		next[field] = sortObjectKeys(next[field] as Record<string, string>);
	}

	return next;
}

/**
 * Serialize a package.json object: 2-space indent with a trailing newline,
 * the convention npm/pnpm/yarn write and most formatters expect.
 */
export function serializePackageJson(
	packageJson: Record<string, unknown>
): string {
	return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function sortObjectKeys(
	record: Record<string, string>
): Record<string, string> {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(record).sort()) {
		const value = record[key];
		if (value !== undefined) {
			sorted[key] = value;
		}
	}
	return sorted;
}
