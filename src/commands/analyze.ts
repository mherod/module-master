import path from "node:path";
import {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import {
	scanBarrelExports,
	scanExports,
	scanModuleReferences,
} from "../core/scanner.ts";
import type { AnalysisResult, ProjectConfig } from "../types.ts";

export interface AnalyzeOptions {
	file: string;
	verbose?: boolean;
	project?: string;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
	const { file, verbose, project: projectArg } = options;

	const absolutePath = path.resolve(file);

	// Find and load project config
	const tsconfigPath = resolveTsConfig(projectArg, path.dirname(absolutePath));
	if (!tsconfigPath) {
		console.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath, absolutePath);
	const result = analyze(absolutePath, project);

	printAnalysis(result, verbose);
}

export function analyze(
	filePath: string,
	project: ProjectConfig,
): AnalysisResult {
	const program = createProgram(project, [filePath]);
	const sourceFile = program.getSourceFile(filePath);

	if (!sourceFile) {
		throw new Error(`Could not parse file: ${filePath}`);
	}

	const imports = scanModuleReferences(sourceFile, project);
	const exports = scanExports(sourceFile);
	const barrelExports = scanBarrelExports(sourceFile, project);

	// Build graph to find reverse references
	const graph = buildDependencyGraph(project);
	const referencedBy = findAllReferences(filePath, graph, project);
	const barrelReExportFiles = findBarrelReExports(filePath, graph);

	// Enhance barrel exports info
	const barrelsWithContext =
		barrelExports.length > 0
			? barrelExports
			: barrelReExportFiles.map((barrelPath) => ({
					barrelPath,
					exports: [],
				}));

	return {
		file: filePath,
		imports,
		exports,
		referencedBy,
		barrelExports: barrelsWithContext,
	};
}

function printAnalysis(result: AnalysisResult, verbose?: boolean): void {
	const fileName = path.basename(result.file);

	console.log(`\n📄 ${fileName}`);
	console.log(`   ${result.file}\n`);

	// Exports
	console.log(`📤 Exports (${result.exports.length}):`);
	if (result.exports.length === 0) {
		console.log("   (none)");
	} else {
		for (const exp of result.exports) {
			const typeMarker = exp.isType ? " (type)" : "";
			const defaultMarker = exp.type === "default" ? " [default]" : "";
			console.log(
				`   • ${exp.name}${typeMarker}${defaultMarker} (line ${exp.line})`,
			);
		}
	}

	console.log();

	// Imports
	console.log(`📥 Imports (${result.imports.length}):`);
	if (result.imports.length === 0) {
		console.log("   (none)");
	} else {
		for (const imp of result.imports) {
			const bindings = imp.bindings
				?.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
				.join(", ");
			const bindingsStr = bindings ? ` { ${bindings} }` : "";
			const typeMarker = imp.isTypeOnly ? " (type-only)" : "";
			console.log(`   • ${imp.specifier}${bindingsStr}${typeMarker}`);
			if (verbose) {
				console.log(`     → ${imp.resolvedPath}`);
				console.log(`     type: ${imp.type}, line: ${imp.line}`);
			}
		}
	}

	console.log();

	// Referenced by
	console.log(`🔗 Referenced by (${result.referencedBy.length} files):`);
	if (result.referencedBy.length === 0) {
		console.log("   (none)");
	} else {
		const grouped = new Map<string, typeof result.referencedBy>();
		for (const ref of result.referencedBy) {
			const existing = grouped.get(ref.sourceFile) ?? [];
			existing.push(ref);
			grouped.set(ref.sourceFile, existing);
		}

		for (const [sourceFile, refs] of grouped) {
			const relativePath = path.relative(process.cwd(), sourceFile);
			console.log(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					console.log(`     line ${ref.line}: ${ref.type} "${ref.specifier}"`);
				}
			}
		}
	}

	console.log();

	// Barrel files
	if (result.barrelExports.length > 0) {
		console.log("📦 Barrel file re-exports:");
		for (const barrel of result.barrelExports) {
			const relativePath = path.relative(process.cwd(), barrel.barrelPath);
			console.log(`   • ${relativePath}`);
			if (verbose && barrel.exports.length > 0) {
				for (const exp of barrel.exports) {
					const alias = exp.alias ? ` as ${exp.alias}` : "";
					console.log(
						`     ${exp.type}: ${exp.name ?? "*"}${alias} from "${exp.from}"`,
					);
				}
			}
		}
		console.log();
	}
}
