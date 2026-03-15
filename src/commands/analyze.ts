import path from "node:path";
import { logger } from "../cli-logger.ts";
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
	scanUnresolvableImports,
} from "../core/scanner.ts";
import { collectUnresolvableDiagnostics } from "../core/verify.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import type { AnalysisResult, ProjectConfig } from "../types.ts";

export interface AnalyzeOptions {
	file: string;
	verbose?: boolean;
	project?: string;
	workspace?: boolean;
	onlyRelatedTo?: string;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
	const {
		file,
		verbose,
		project: projectArg,
		workspace = false,
		onlyRelatedTo,
	} = options;

	const absolutePath = path.resolve(file);

	// Find and load project config
	const tsconfigPath = resolveTsConfig(projectArg, path.dirname(absolutePath));
	if (!tsconfigPath) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const project = loadProject(tsconfigPath, absolutePath);
	const result = await analyze(absolutePath, project);

	// When workspace mode is enabled, find cross-package references
	if (workspace) {
		const wsDir = projectArg
			? path.resolve(projectArg)
			: path.dirname(tsconfigPath);
		const wsInfo = await discoverWorkspace(wsDir);
		if (wsInfo && wsInfo.packages.length > 0) {
			// Guard: reject if file is outside workspace root
			if (filterToWorkspaceBoundary([absolutePath], wsInfo.root).length === 0) {
				logger.error(`File is outside workspace root: ${wsInfo.root}`);
				process.exit(1);
			}
			const { mapConcurrent } = await import("../core/concurrency.ts");
			const eligiblePkgs = wsInfo.packages.filter(
				(pkg) => pkg.tsconfigPath && pkg.tsconfigPath !== tsconfigPath
			);
			const pkgResults = await mapConcurrent(
				eligiblePkgs,
				async (pkg) => {
					const pkgProject = loadProject(pkg.tsconfigPath as string);
					const pkgGraph = await buildDependencyGraph(pkgProject);
					const refs = findAllReferences(absolutePath, pkgGraph);
					return refs.filter(
						(r) =>
							filterToWorkspaceBoundary([r.sourceFile], wsInfo.root).length > 0
					);
				},
				{ onError: () => [] }
			);
			const crossRefs = pkgResults.flat();
			if (crossRefs.length > 0) {
				result.referencedBy.push(...crossRefs);
			}
		}
	}

	// Filter references to only related paths when requested
	if (onlyRelatedTo) {
		const { matchesRelatedPath } = await import("../core/similarity.ts");
		result.referencedBy = result.referencedBy.filter((ref) =>
			matchesRelatedPath(ref.sourceFile, onlyRelatedTo)
		);
	}

	printAnalysis(result, verbose);

	const projectDiagnostics = collectUnresolvableDiagnostics(project);
	if (projectDiagnostics.length > 0) {
		logger.warn(
			`\n⚠️  ${projectDiagnostics.length} unresolvable import(s) across project:`
		);
		for (const diag of projectDiagnostics) {
			logger.warn(`   ${diag.file}:${diag.line}: "${diag.specifier}"`);
		}
	}
}

export async function analyze(
	filePath: string,
	project: ProjectConfig
): Promise<AnalysisResult> {
	const program = createProgram(project, [filePath]);
	const sourceFile = program.getSourceFile(filePath);

	if (!sourceFile) {
		throw new Error(`Could not parse file: ${filePath}`);
	}

	const imports = scanModuleReferences(sourceFile, project);
	const exports = scanExports(sourceFile);
	const barrelExports = scanBarrelExports(sourceFile, project);
	const unresolvable = scanUnresolvableImports(sourceFile, project);

	// Build graph to find reverse references
	const graph = await buildDependencyGraph(project);
	const referencedBy = findAllReferences(filePath, graph);
	const barrelReExportFiles = findBarrelReExports(filePath, graph);

	// Enhance barrel exports info
	const barrelsWithContext =
		barrelExports.length > 0
			? barrelExports
			: barrelReExportFiles.map((barrelPath) => ({
					barrelPath,
					resolvedPath: filePath,
					exports: [],
				}));

	return {
		file: filePath,
		imports,
		exports,
		referencedBy,
		barrelExports: barrelsWithContext,
		unresolvable,
	};
}

function printAnalysis(result: AnalysisResult, verbose?: boolean): void {
	const fileName = path.basename(result.file);

	logger.info(`\n📄 ${fileName}`);
	logger.info(`   ${result.file}\n`);

	// Exports
	logger.info(`📤 Exports (${result.exports.length}):`);
	if (result.exports.length === 0) {
		logger.info("   (none)");
	} else {
		for (const exp of result.exports) {
			const typeMarker = exp.isType ? " (type)" : "";
			const defaultMarker = exp.type === "default" ? " [default]" : "";
			logger.info(
				`   • ${exp.name}${typeMarker}${defaultMarker} (line ${exp.line})`
			);
		}
	}

	logger.empty();

	// Imports
	logger.info(`📥 Imports (${result.imports.length}):`);
	if (result.imports.length === 0) {
		logger.info("   (none)");
	} else {
		for (const imp of result.imports) {
			const bindings = imp.bindings
				?.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
				.join(", ");
			const bindingsStr = bindings ? ` { ${bindings} }` : "";
			const typeMarker = imp.isTypeOnly ? " (type-only)" : "";
			logger.info(`   • ${imp.specifier}${bindingsStr}${typeMarker}`);
			if (verbose) {
				logger.info(`     → ${imp.resolvedPath}`);
				logger.info(`     type: ${imp.type}, line: ${imp.line}`);
			}
		}
	}

	logger.empty();

	// Referenced by
	logger.info(`🔗 Referenced by (${result.referencedBy.length} files):`);
	if (result.referencedBy.length === 0) {
		logger.info("   (none)");
	} else {
		const grouped = new Map<string, typeof result.referencedBy>();
		for (const ref of result.referencedBy) {
			const existing = grouped.get(ref.sourceFile) ?? [];
			existing.push(ref);
			grouped.set(ref.sourceFile, existing);
		}

		for (const [sourceFile, refs] of grouped) {
			const relativePath = path.relative(process.cwd(), sourceFile);
			logger.info(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					logger.info(`     line ${ref.line}: ${ref.type} "${ref.specifier}"`);
				}
			}
		}
	}

	logger.empty();

	// Unresolvable imports
	if (result.unresolvable.length > 0) {
		logger.info(`⚠️  Unresolvable imports (${result.unresolvable.length}):`);
		for (const diag of result.unresolvable) {
			logger.info(`   • "${diag.specifier}" (line ${diag.line})`);
			if (verbose) {
				logger.info(`     ${diag.diagnostic}`);
			}
		}
		logger.empty();
	}

	// Barrel files
	if (result.barrelExports.length > 0) {
		logger.info("📦 Barrel file re-exports:");
		for (const barrel of result.barrelExports) {
			const relativePath = path.relative(process.cwd(), barrel.barrelPath);
			logger.info(`   • ${relativePath}`);
			if (verbose && barrel.exports.length > 0) {
				for (const exp of barrel.exports) {
					const alias = exp.alias ? ` as ${exp.alias}` : "";
					logger.info(
						`     ${exp.type}: ${exp.name ?? "*"}${alias} from "${exp.from}"`
					);
				}
			}
		}
		logger.empty();
	}
}
