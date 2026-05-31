import type { MutatingCommandOptions } from "./commands.ts";

export interface InlineOptions extends MutatingCommandOptions {
	/** Path to the barrel file to inline. */
	barrelFile: string;
	/** Run tsc --noEmit before/after (default true; --no-verify disables). */
	verify?: boolean;
	/** Emit machine-readable JSON. */
	json?: boolean;
}

/** One rewritten import in one importer file. */
export interface InlineRewrite {
	file: string;
	line: number;
	oldSpecifier: string;
	newSpecifier: string;
	bindings: string[];
	typeOnly: boolean;
}

/** A skipped or blocked importer (conflict or unsupported import form). */
export interface InlineConflict {
	file: string;
	line: number;
	reason: string;
}

export interface InlineResult {
	barrelFile: string;
	isPureBarrel: boolean;
	/** Single canonical source, or null when the barrel has multiple sources. */
	canonicalSpecifier: string | null;
	rewrites: InlineRewrite[];
	conflicts: InlineConflict[];
	filesChanged: number;
	dryRun: boolean;
}
