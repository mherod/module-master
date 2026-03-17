import type { BarrelExport, ModuleReference } from "./graph.ts";

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
