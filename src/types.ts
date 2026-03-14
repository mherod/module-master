import type ts from "typescript";

export interface ProjectConfig {
	rootDir: string;
	tsconfigPath: string;
	compilerOptions: ts.CompilerOptions;
	pathAliases: Map<string, string[]>;
	/** Include glob patterns from tsconfig */
	include: string[];
	/** Exclude glob patterns from tsconfig */
	exclude: string[];
	/** All resolved file paths included in this project */
	files: string[];
	/** Project references (for solution-style tsconfigs) */
	references?: ProjectReference[];
}

export interface ProjectReference {
	/** Path to the referenced tsconfig */
	path: string;
	/** Whether the reference is prepended */
	prepend?: boolean;
	/** Whether the reference is circular */
	circular?: boolean;
}

export interface ModuleReference {
	/** The file containing the reference */
	sourceFile: string;
	/** The module specifier as written in code */
	specifier: string;
	/** Resolved absolute path of the referenced module */
	resolvedPath: string;
	/** Type of import/export */
	type: ReferenceType;
	/** Line number in source file */
	line: number;
	/** Column number in source file */
	column: number;
	/** For named imports/exports, the specific bindings */
	bindings?: ImportBinding[];
	/** Whether this is a type-only import */
	isTypeOnly: boolean;
}

export type ReferenceType =
	| "import" // import x from './x'
	| "import-named" // import { x } from './x'
	| "import-namespace" // import * as x from './x'
	| "import-side-effect" // import './x'
	| "import-dynamic" // import('./x')
	| "export-from" // export { x } from './x'
	| "export-all" // export * from './x'
	| "export-all-as" // export * as x from './x'
	| "require" // require('./x')
	| "require-resolve" // require.resolve('./x')
	| "jest-mock"; // jest.mock('./x') or vi.mock('./x')

export interface ImportBinding {
	name: string;
	alias?: string;
	isType: boolean;
}

export interface BarrelExport {
	/** The barrel file (index.ts) path */
	barrelPath: string;
	/** The resolved absolute path of the module being re-exported */
	resolvedPath: string;
	/** What this barrel re-exports from the target */
	exports: BarrelExportEntry[];
}

export interface BarrelExportEntry {
	type: "named" | "all" | "all-as" | "default";
	/** For named exports, the exported name */
	name?: string;
	/** For aliased exports, the alias */
	alias?: string;
	/** The source module this is re-exported from */
	from: string;
}

export interface MoveOperation {
	sourcePath: string;
	targetPath: string;
	dryRun: boolean;
}

export interface MoveResult {
	success: boolean;
	movedFile: { from: string; to: string };
	updatedReferences: UpdatedReference[];
	errors: MoveError[];
}

export interface UpdatedReference {
	file: string;
	line: number;
	oldSpecifier: string;
	newSpecifier: string;
}

export interface MoveError {
	file: string;
	message: string;
	recoverable: boolean;
}

export interface AnalysisResult {
	file: string;
	imports: ModuleReference[];
	exports: ExportInfo[];
	referencedBy: ModuleReference[];
	barrelExports: BarrelExport[];
	unresolvable: Array<{
		specifier: string;
		line: number;
		diagnostic: string;
	}>;
}

export interface ExportInfo {
	name: string;
	type: "named" | "default" | "namespace";
	isType: boolean;
	line: number;
}

export interface FunctionInfo {
	/** Absolute path to the file */
	file: string;
	/** Function name */
	name: string;
	/** Line number where the function starts */
	line: number;
	/** Column number */
	column: number;
	/** Normalized body text for comparison */
	normalizedBody: string;
	/** Number of tokens in the normalized body */
	tokenCount: number;
	/** Length of the original (pre-normalization) body text */
	bodyLength: number;
	/** Number of lines in the original function body */
	bodyLines: number;
	/** Whether the function body contains a compile-time directive */
	hasDirective: boolean;
	/** Semantic content tokens: uppercase identifiers and string literal values from the original body */
	contentTokens: string[];
}

export type SimilarityBucket = "exact" | "high" | "medium";

export interface SimilarityGroup {
	/** Similarity level */
	bucket: SimilarityBucket;
	/** Similarity score (0–1) */
	score: number;
	/** Functions in this group */
	functions: FunctionInfo[];
}

export interface SimilarityReport {
	/** All groups of similar functions, ranked by score descending */
	groups: SimilarityGroup[];
	/** Total functions scanned */
	totalFunctions: number;
	/** Total files scanned */
	totalFiles: number;
}
