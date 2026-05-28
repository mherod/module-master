import type { ReadOnlyCommandOptions } from "./commands.ts";
import type { MoveResult } from "./move.ts";

export type TestRelocationReason = "stranded" | "misnamed";

export interface TestRelocationImport {
	file: string;
	count: number;
}

export interface TestRelocation {
	testFile: string;
	currentLocation: string;
	suggestedLocation: string;
	reason: TestRelocationReason;
	reasons: TestRelocationReason[];
	imports: TestRelocationImport[];
}

export interface TestRelocationOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
	fix?: boolean;
	dryRun?: boolean;
	force?: boolean;
	verbose?: boolean;
	conventionThreshold?: number;
}

export interface TestRelocationReport {
	schemaVersion: "1";
	directory: string;
	generatedAt: string;
	findings: TestRelocation[];
	summary: {
		totalFindings: number;
		filesTouched: number;
		totalTests: number;
		stranded: number;
		misnamed: number;
		convention: "tests-directory" | "alongside";
		conventionThreshold: number;
	};
}

export interface TestRelocationApplyResult {
	dryRun: boolean;
	success: boolean;
	report: TestRelocationReport;
	moves: MoveResult[];
	typecheck?: {
		errorsBefore: string[];
		errorsAfter: string[];
		newErrors: string[];
		verificationIncomplete: boolean;
	};
	rolledBack: boolean;
	errors: string[];
}
