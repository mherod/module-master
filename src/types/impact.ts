/**
 * Types for the read-only `analyze-impact` scouting command (#99).
 *
 * `analyze-impact` reports the blast radius of a proposed `move`/`rename`
 * BEFORE any mutation, so agents stop discovering impact by trial-and-error.
 */

/** Coarse risk band derived from instability, boundary crossings, and missing deps. */
export type BreakingRisk = "low" | "medium" | "high";

/** The read-only impact radius of a proposed `move`/`rename` (`source` → `target`). */
export interface ImpactReport {
	/** Absolute path of the file proposed to move/rename. */
	source: string;
	/** Absolute path of the proposed destination. */
	target: string;
	/** Direct + indirect (barrel-chain) importers of `source`. */
	impactedFilesCount: number;
	/** Distinct workspace package boundaries crossed between `source` and `target`. */
	boundaryCrossedCount: number;
	/** Coarse breaking-risk band for the proposed change. */
	breakingRisk: BreakingRisk;
	/** External imports of `source` absent from the target package's `package.json`. */
	missingDependencies: string[];
}
