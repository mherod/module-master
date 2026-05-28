import type { DeclarationKind, SimilarityBucket } from "./similar.ts";

export type TidySchemaVersion = "1-experimental";

export interface TidyOptions {
	directory: string;
	project?: string;
	workspace?: boolean;
	verbose?: boolean;
	json?: boolean;
	experimental?: boolean;
	scope?: string;
	out?: string;
	fanOutThreshold?: number;
	fanInThreshold?: number;
	exportThreshold?: number;
}

export interface TidyUnusedFinding {
	kind: "unused";
	sourceFile: string;
	name: string;
	line: number;
	exportKind: string;
	isType: boolean;
	internalUsage: boolean;
	internalRefCount: number;
}

export interface TidySimilarMember {
	sourceFile: string;
	name: string;
	kind: DeclarationKind;
	line: number;
}

export interface TidySimilarFinding {
	kind: "similar";
	sourceFile: string;
	groupIndex: number;
	bucket: SimilarityBucket;
	score: number;
	members: TidySimilarMember[];
}

export interface TidyAuditCycleFinding {
	kind: "audit-cycle";
	sourceFile: string;
	files: string[];
}

export interface TidyAuditMetricFinding {
	kind: "audit-fan-out" | "audit-fan-in" | "audit-export-surface";
	sourceFile: string;
	value: number;
	threshold: number;
	instability: number;
}

export type TidyAuditFinding = TidyAuditCycleFinding | TidyAuditMetricFinding;

export type TidyFinding =
	| TidyUnusedFinding
	| TidySimilarFinding
	| TidyAuditFinding;

export interface TidyReport {
	schemaVersion: TidySchemaVersion;
	directory: string;
	scope: string | null;
	generatedAt: string;
	findings: {
		unused: TidyUnusedFinding[];
		similar: TidySimilarFinding[];
		audit: TidyAuditFinding[];
	};
	summary: {
		totalFindings: number;
		filesTouched: 0;
		categories: {
			unused: number;
			similar: number;
			audit: number;
		};
		scanned: {
			unusedFiles: number;
			similarFiles: number;
			auditFiles: number;
		};
	};
}
