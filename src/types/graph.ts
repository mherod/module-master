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
