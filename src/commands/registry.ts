import { name } from "../../package.json";
import { logger } from "../cli-logger.ts";
import { aliasCommand } from "./alias.ts";
import { analyzeCommand } from "./analyze.ts";
import { auditCommand } from "./audit.ts";
import { discoverCommand } from "./discover.ts";
import { extractCommonCommand } from "./extract-common.ts";
import { findCommand } from "./find.ts";
import { mockCleanupCommand } from "./mock-cleanup.ts";
import { moveCommand } from "./move.ts";
import { namingCommand } from "./naming.ts";
import { renameCommand } from "./rename.ts";
import { similarCommand } from "./similar.ts";
import { testRelocationCommand } from "./test-relocation.ts";
import { parseTidyFixCategories, tidyCommand } from "./tidy.ts";
import { workspaceCommand } from "./workspace.ts";

export interface CliValues {
	help?: boolean;
	ignore?: string;
	version?: boolean;
	verbose?: boolean;
	"dry-run"?: boolean;
	project?: string;
	type?: string;
	prefer?: string;
	"rename-specifier"?: string[];
	force?: boolean;
	"no-verify"?: boolean;
	fix?: boolean;
	"fix-category"?: string[];
	json?: boolean;
	threshold?: string;
	"max-groups"?: string;
	"max-changes"?: string;
	strict?: boolean;
	"name-threshold"?: string;
	"same-name-only"?: boolean;
	"skip-same-file"?: boolean;
	"only-related-to"?: string;
	"min-lines"?: string;
	"skip-directives"?: boolean;
	"skip-wrappers"?: boolean;
	kinds?: string;
	group?: string;
	output?: string;
	workspace?: boolean;
	experimental?: boolean;
	scope?: string;
	out?: string;
	"fan-out-threshold"?: string;
	"fan-in-threshold"?: string;
	"export-threshold"?: string;
	"min-siblings"?: string;
	"majority-threshold"?: string;
	"include-tests"?: boolean;
	"convention-threshold"?: string;
	bucket?: string;
	format?: string;
}

export interface CommandDef {
	name: string;
	helpText: string;
	run: (args: string[], values: CliValues) => Promise<void> | void;
}

export const COMMANDS: CommandDef[] = [
	{
		name: "move",
		helpText: `
Usage: ${name} move <source> <target> [options]

Move a TypeScript/JavaScript module to a new location and update all references.

Arguments:
  source    Path to the file to move
  target    Destination path for the file

Options:
  -n, --dry-run   Preview changes without modifying files
  --force         Allow operation when git worktree has uncommitted changes
  --verbose       Show detailed information about each change
  --workspace     Scan across all workspace packages

Features:
  • Updates all import statements referencing the moved file
  • Preserves path aliases when possible
  • Updates barrel file re-exports
  • Handles dynamic imports and require() calls
  • Updates internal imports within the moved file

Examples:
  ${name} move src/utils/old.ts src/helpers/new.ts
  ${name} move src/components/Button.tsx src/ui/Button.tsx --dry-run
`,
		run: async ([source, target], values) => {
			if (!(source && target)) {
				logger.error("Error: move requires <source> and <target> arguments");
				logger.error(`Run '${name} move --help' for usage`);
				process.exit(1);
			}
			await moveCommand({
				source,
				target,
				dryRun: values["dry-run"],
				force: values.force,
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
				workspace: values.workspace,
			});
		},
	},

	{
		name: "rename",
		helpText: `
Usage: ${name} rename <file> <oldName> <newName> [options]

Rename an exported symbol (class, function, component, type) and update all imports.

Arguments:
  file       Path to the file containing the export
  oldName    Current name of the export
  newName    New name for the export

Options:
  -n, --dry-run   Preview changes without modifying files
  --force         Allow operation when git worktree has uncommitted changes
  --verbose       Show detailed information about each change
  --workspace     Scan across all workspace packages

Features:
  • Renames the export in the source file
  • Updates all named imports across the codebase
  • Updates barrel file re-exports
  • Preserves import aliases (import { Old as X } → import { New as X })
  • Handles classes, functions, constants, types, and interfaces

Examples:
  ${name} rename src/components/Button.tsx Button PrimaryButton
  ${name} rename src/utils/api.ts fetchUser getUser --dry-run
  ${name} rename src/types.ts UserDTO User --verbose
`,
		run: async ([file, oldName, newName], values) => {
			if (!(file && oldName && newName)) {
				logger.error(
					"Error: rename requires <file>, <oldName>, and <newName> arguments"
				);
				logger.error(`Run '${name} rename --help' for usage`);
				process.exit(1);
			}
			await renameCommand({
				file,
				oldName,
				newName,
				dryRun: values["dry-run"],
				force: values.force,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
			});
		},
	},

	{
		name: "analyze",
		helpText: `
Usage: ${name} analyze <file> [options]

Analyze a module's imports, exports, and references throughout the codebase.

Arguments:
  file    Path to the file to analyze

Options:
  --verbose          Show detailed reference information
  --workspace        Scan across all workspace packages
  --only-related-to  Filter referencedBy results to a file, folder, or glob pattern

Output includes:
  • All exports from the file
  • All imports used by the file
  • All files that reference this module
  • Barrel files that re-export this module

Examples:
  ${name} analyze src/utils/helpers.ts
  ${name} analyze src/components/Button.tsx --verbose
`,
		run: async ([file], values) => {
			if (!file) {
				logger.error("Error: analyze requires a <file> argument");
				logger.error(`Run '${name} analyze --help' for usage`);
				process.exit(1);
			}
			await analyzeCommand({
				file,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "discover",
		helpText: `
Usage: ${name} discover <directory> [options]

Discover all tsconfig.json files in a directory and understand project structure.

Arguments:
  directory    Path to the project directory to scan

Options:
  --verbose          Show detailed file ownership and path aliases
  --workspace        Scan across all workspace packages
  --only-related-to  Filter file ownership output to a file, folder, or glob pattern

Output includes:
  • All tsconfig.json files found
  • Include/exclude patterns for each config
  • Project references (for solution-style configs)
  • File ownership map (which config controls each file)

Examples:
  ${name} discover .
  ${name} discover /path/to/project --verbose
  ${name} discover . --workspace
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: discover requires a <directory> argument");
				logger.error(`Run '${name} discover --help' for usage`);
				process.exit(1);
			}
			await discoverCommand({
				directory,
				verbose: values.verbose,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "workspace",
		helpText: `
Usage: ${name} workspace <directory> [options]

Discover pnpm/yarn/npm workspace packages and their structure.

Arguments:
  directory    Path to the workspace root

Options:
  --verbose    Show detailed export maps
  --json       Output results as JSON

Examples:
  ${name} workspace .
  ${name} workspace . --json
  ${name} workspace . --verbose
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: workspace requires a <directory> argument");
				logger.error(`Run '${name} workspace --help' for usage`);
				process.exit(1);
			}
			await workspaceCommand({
				directory,
				verbose: values.verbose,
				json: values.json,
			});
		},
	},

	{
		name: "find",
		helpText: `
Usage: ${name} find <query> -p <project> [options]

Find files and exports by name within a project.

Arguments:
  query    Name to search for (case-insensitive, partial match)

Options:
  -p, --project      Path to project directory (required)
  -t, --type         Filter: file, export, or all (default: all)
  --verbose          Show helpful tips for next steps
  --workspace        Scan across all workspace packages
  --only-related-to  Limit searched files to a file, folder, or glob pattern

Output includes:
  • Files matching the query by filename
  • Exports matching the query by name
  • Line numbers for each export

Examples:
  ${name} find Entity -p /path/to/project
  ${name} find User -p . --type export
  ${name} find config -p . --type file --verbose
`,
		run: async ([query], values) => {
			if (!query) {
				logger.error("Error: find requires a <query> argument");
				logger.error(`Run '${name} find --help' for usage`);
				process.exit(1);
			}
			if (!values.project) {
				logger.error("Error: find requires -p <project> option");
				logger.error(`Run '${name} find --help' for usage`);
				process.exit(1);
			}
			const findType = values.type as "file" | "export" | "all" | undefined;
			if (findType && !["file", "export", "all"].includes(findType)) {
				logger.error("Error: --type must be 'file', 'export', or 'all'");
				process.exit(1);
			}
			await findCommand({
				query,
				project: values.project,
				type: findType,
				verbose: values.verbose,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "alias",
		helpText: `
Usage: ${name} alias <target> --prefer=<strategy> [options]
       ${name} alias <target> --rename-specifier="<from>=<to>" [options]

Normalize import specifiers to use path aliases, relative paths, or the shortest option.
Rewrite exact import specifiers with --rename-specifier for case-only alias moves.

Arguments:
  target    File or directory to process

Options:
  --prefer        Strategy: alias, relative, or shortest (required unless --rename-specifier is used)
  --rename-specifier  Exact specifier rewrite pair: <from>=<to> (repeatable)
  -p, --project   Path to project directory or tsconfig.json
  -n, --dry-run   Preview changes without modifying files
  --force         Allow operation when git worktree has uncommitted changes
  --no-verify     Disable type checking verification (enabled by default)
  --verbose       Show detailed changes
  --workspace     Scan across all workspace packages

Strategies:
  alias      Convert to tsconfig path aliases where possible
  relative   Convert to relative paths (./... or ../...)
  shortest   Pick whichever is shorter

Verification:
  By default, runs tsc --noEmit before and after changes to ensure no
  type errors are introduced. Use --no-verify to skip this check.

Examples:
  ${name} alias src --prefer=alias
  ${name} alias src/utils --prefer=relative --dry-run
  ${name} alias src/components/Button.tsx --prefer=shortest
  ${name} alias src --prefer=alias --no-verify
  ${name} alias src --rename-specifier="@utils/Foo=@utils/foo"
`,
		run: async ([target], values) => {
			if (!target) {
				logger.error("Error: alias requires a <target> argument");
				logger.error(`Run '${name} alias --help' for usage`);
				process.exit(1);
			}
			const renameSpecifiers = values["rename-specifier"] ?? [];
			if (!(values.prefer || renameSpecifiers.length > 0)) {
				logger.error("Error: alias requires --prefer option");
				logger.error(`Run '${name} alias --help' for usage`);
				process.exit(1);
			}
			const prefer = values.prefer as
				| "alias"
				| "relative"
				| "shortest"
				| undefined;
			if (prefer && !["alias", "relative", "shortest"].includes(prefer)) {
				logger.error(
					"Error: --prefer must be 'alias', 'relative', or 'shortest'"
				);
				process.exit(1);
			}
			await aliasCommand({
				target,
				prefer,
				dryRun: values["dry-run"],
				force: values.force,
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
				renameSpecifiers,
				workspace: values.workspace,
			});
		},
	},

	{
		name: "similar",
		helpText: `
Usage: ${name} similar <directory> [options]

Scan a project or directory for similar or duplicate top-level functions,
type aliases, and interfaces. Reports candidate groups with similarity score,
file paths, symbol names, and line numbers for consolidation work.

Arguments:
  directory    Path to the project directory to scan

Options:
  --json            Output results as JSON
  --threshold       Minimum similarity score 0.0–1.0 (default: 0.8)
  --max-groups      Maximum number of groups to display (default: 10, 0 for unlimited)
  --strict          Exit with error code 1 if similar declarations are found (for CI/hooks)
  --name-threshold  Only group declarations whose names also meet this similarity (0.0–1.0)
  --same-name-only  Only group declarations with identical names
  --skip-same-file  Skip groups where all declarations are in the same file
  --only-related-to Only show groups related to a file or folder (path or glob)
  --min-lines       Exclude declarations with fewer body lines (filters thin wrappers)
  --skip-directives Skip functions containing compile-time directives
  --kinds           Comma-separated list of declaration kinds to include:
                    function, type, interface (default: all)
  --bucket          Filter groups by similarity bucket: exact, high, or medium
  --format          Output format: compact (minimal name + file:line per group)
  --workspace       Scan across all workspace packages
  -p, --project     Path to project directory or tsconfig.json

Similarity buckets:
  exact   Identical after normalization (renamed identifiers or literal differences)
  high    ≥85% token overlap
  medium  ≥80% token overlap

Name filtering:
  Uses camelCase token comparison. E.g., makeTempDir and createTempDir
  share tokens "temp" + "dir" and score high, while isShellTool and
  createTempDir share nothing and are filtered out.

Examples:
  ${name} similar src
  ${name} similar . --threshold=0.85
  ${name} similar src --json
  ${name} similar . --workspace
  ${name} similar src --max-groups=20
  ${name} similar src --strict              # fail if duplicates found
  ${name} similar src --name-threshold=0.5  # require similar names
  ${name} similar src --same-name-only      # only identical names
  ${name} similar src --only-related-to=src/utils/helpers.ts
  ${name} similar src --kinds=function      # functions only (previous default)
  ${name} similar src --kinds=type,interface # types and interfaces only
  ${name} similar src --bucket=exact        # only exact duplicates
  ${name} similar src --format=compact      # minimal output for scripting
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: similar requires a <directory> argument");
				logger.error(`Run '${name} similar --help' for usage`);
				process.exit(1);
			}
			const rawThreshold = values.threshold;
			const threshold = rawThreshold === undefined ? 0.8 : Number(rawThreshold);
			if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
				logger.error("Error: --threshold must be a number between 0.0 and 1.0");
				process.exit(1);
			}
			const rawMaxGroups = values["max-groups"];
			const maxGroups = rawMaxGroups === undefined ? 10 : Number(rawMaxGroups);
			if (Number.isNaN(maxGroups) || maxGroups < 0) {
				logger.error("Error: --max-groups must be a non-negative integer");
				process.exit(1);
			}
			const rawNameThreshold = values["name-threshold"];
			const nameThreshold =
				rawNameThreshold === undefined ? undefined : Number(rawNameThreshold);
			if (
				nameThreshold !== undefined &&
				(Number.isNaN(nameThreshold) || nameThreshold < 0 || nameThreshold > 1)
			) {
				logger.error(
					"Error: --name-threshold must be a number between 0.0 and 1.0"
				);
				process.exit(1);
			}
			const validKinds = ["function", "type", "interface"] as const;
			type ValidKind = (typeof validKinds)[number];
			const kindsArg = values.kinds
				? values.kinds
						.split(",")
						.map((k) => k.trim())
						.filter((k): k is ValidKind =>
							(validKinds as readonly string[]).includes(k)
						)
				: undefined;
			const validBuckets = ["exact", "high", "medium"] as const;
			type ValidBucket = (typeof validBuckets)[number];
			const bucketArg = values.bucket as ValidBucket | undefined;
			if (
				bucketArg &&
				!(validBuckets as readonly string[]).includes(bucketArg)
			) {
				logger.error("Error: --bucket must be 'exact', 'high', or 'medium'");
				process.exit(1);
			}
			const formatArg = values.format as "compact" | undefined;
			if (formatArg && formatArg !== "compact") {
				logger.error("Error: --format must be 'compact'");
				process.exit(1);
			}
			await similarCommand({
				directory,
				project: values.project,
				json: values.json,
				threshold,
				maxGroups,
				strict: values.strict,
				workspace: values.workspace,
				nameThreshold,
				sameNameOnly: values["same-name-only"],
				skipSameFile: values["skip-same-file"],
				onlyRelatedTo: values["only-related-to"],
				minLines: values["min-lines"] ? Number(values["min-lines"]) : undefined,
				skipDirectives: values["skip-directives"],
				skipWrappers: values["skip-wrappers"],
				kinds: kindsArg,
				bucket: bucketArg,
				format: formatArg,
			});
		},
	},

	{
		name: "extract-common",
		helpText: `
Usage: ${name} extract-common <directory> [options]

Extract duplicate functions found by 'similar' into shared modules.
Keeps one canonical copy and replaces all others with imports.

Arguments:
  directory    Path to the project directory to scan

Options:
  --threshold        Minimum similarity score 0.0–1.0 (default: 0.95)
  --group            Target a specific group number (from 'similar' output)
  -o, --output       Write extracted functions to this file (consolidate into one location)
  -n, --dry-run      Preview changes without modifying files
  --force            Allow operation when git worktree has uncommitted changes
  --json             Output results as JSON
  --strict           Exit 1 if extractable duplicate groups are found (use with --dry-run for CI)
  --skip-same-file   Skip groups where all functions are in the same file
  --only-related-to  Only process groups related to a file or folder (path or glob)
  --min-lines        Exclude functions with fewer body lines (filters thin wrappers)
  --skip-directives  Skip functions containing compile-time directives
  --name-threshold   Name similarity threshold 0.0–1.0 for filtering groups by function name
  --same-name-only   Only group functions with identical names
  --workspace        Scan across all workspace packages
  -p, --project      Path to project directory or tsconfig.json

Without --output, keeps one canonical copy in place and removes others.
With --output, writes the function to the specified file and removes from all sources.

Examples:
  ${name} extract-common src --dry-run
  ${name} extract-common . --threshold=1.0
  ${name} extract-common src --group=1
  ${name} extract-common src --output=src/shared/utils.ts
  ${name} extract-common src --only-related-to=src/utils/helpers.ts
  ${name} extract-common . --workspace
  ${name} extract-common src --dry-run --json
  ${name} extract-common src --dry-run --strict
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: extract-common requires a <directory> argument");
				logger.error(`Run '${name} extract-common --help' for usage`);
				process.exit(1);
			}
			const rawThreshold = values.threshold;
			const threshold =
				rawThreshold === undefined ? 0.95 : Number(rawThreshold);
			if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
				logger.error("Error: --threshold must be a number between 0.0 and 1.0");
				process.exit(1);
			}
			const rawGroup = values.group;
			const group = rawGroup === undefined ? undefined : Number(rawGroup);
			await extractCommonCommand({
				directory,
				project: values.project,
				threshold,
				dryRun: values["dry-run"],
				force: values.force,
				json: values.json,
				strict: values.strict,
				group,
				workspace: values.workspace,
				output: values.output,
				skipSameFile: values["skip-same-file"],
				onlyRelatedTo: values["only-related-to"],
				minLines: values["min-lines"] ? Number(values["min-lines"]) : undefined,
				skipDirectives: values["skip-directives"],
				nameThreshold: values["name-threshold"]
					? Number(values["name-threshold"])
					: undefined,
				sameNameOnly: values["same-name-only"],
				skipWrappers: values["skip-wrappers"],
			});
		},
	},

	{
		name: "test-relocation",
		helpText: `
Usage: ${name} test-relocation <directory> [options]

Find stranded or misnamed test files from their imports-under-test.

Arguments:
  directory    Path to the project directory to scan

Options:
  --json                    Output results as JSON
  --fix                     Move tests via the existing move pipeline
  -n, --dry-run             Preview even when --fix is set
  --force                   Allow --fix when the git worktree is dirty
  --convention-threshold    Required __tests__ majority 0.0-1.0 or 0-100 (default: 0.7)

Examples:
  ${name} test-relocation src
  ${name} test-relocation src --json
  ${name} test-relocation src --fix
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: test-relocation requires a <directory> argument");
				logger.error(`Run '${name} test-relocation --help' for usage`);
				process.exit(1);
			}
			const rawConventionThreshold = values["convention-threshold"];
			const conventionThreshold =
				rawConventionThreshold === undefined
					? undefined
					: Number(rawConventionThreshold);
			if (
				conventionThreshold !== undefined &&
				(Number.isNaN(conventionThreshold) ||
					conventionThreshold < 0 ||
					conventionThreshold > 100)
			) {
				logger.error(
					"Error: --convention-threshold must be between 0.0 and 1.0 or 0 and 100"
				);
				process.exit(1);
			}
			let normalizedThreshold: number | undefined;
			if (conventionThreshold !== undefined) {
				normalizedThreshold =
					conventionThreshold > 1
						? conventionThreshold / 100
						: conventionThreshold;
			}
			try {
				await testRelocationCommand({
					directory,
					project: values.project,
					workspace: values.workspace,
					verbose: values.verbose,
					json: values.json,
					fix: values.fix,
					dryRun: values["dry-run"],
					force: values.force,
					conventionThreshold: normalizedThreshold,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "mock-cleanup",
		helpText: `
Usage: ${name} mock-cleanup <directory> [options]

Find mock factory keys that no longer exist as exports on the mocked module.

Arguments:
  directory    Path to the project directory to scan

Options:
  --json        Output results as JSON
  --fix         Remove orphan factory keys and run type checking
  -n, --dry-run Preview even when --fix is set
  --force       Allow --fix when the git worktree is dirty
  --no-verify   Skip type checking verification (not recommended)

Examples:
  ${name} mock-cleanup src
  ${name} mock-cleanup src --json
  ${name} mock-cleanup src --fix
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: mock-cleanup requires a <directory> argument");
				logger.error(`Run '${name} mock-cleanup --help' for usage`);
				process.exit(1);
			}
			try {
				await mockCleanupCommand({
					directory,
					project: values.project,
					json: values.json,
					fix: values.fix,
					dryRun: values["dry-run"],
					force: values.force,
					verify: !values["no-verify"],
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "naming",
		helpText: `
Usage: ${name} naming <directory> [options]

Audit per-directory filename casing conventions and report outliers.

Arguments:
  directory    Path to the project directory to scan

Options:
  --json                  Output results as JSON
  --workspace             Scan across workspace packages
  --min-siblings          Minimum files in a directory before auditing (default: 3)
  --majority-threshold    Required casing majority 0.0-1.0 (default: 0.6)
  --include-tests         Include *.test.* and *.spec.* files
  --fix                   Blocked until safe case-only move support lands (#72/#73)
  --force                 Allow --fix past dirty-worktree guard before the blocked gate

Examples:
  ${name} naming src
  ${name} naming src --json
  ${name} naming src --majority-threshold=0.8
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: naming requires a <directory> argument");
				logger.error(`Run '${name} naming --help' for usage`);
				process.exit(1);
			}
			const rawMinSiblings = values["min-siblings"];
			const minSiblings =
				rawMinSiblings === undefined ? undefined : Number(rawMinSiblings);
			if (
				minSiblings !== undefined &&
				(!Number.isInteger(minSiblings) || minSiblings < 1)
			) {
				logger.error("Error: --min-siblings must be a positive integer");
				process.exit(1);
			}
			const rawMajorityThreshold = values["majority-threshold"];
			const majorityThreshold =
				rawMajorityThreshold === undefined
					? undefined
					: Number(rawMajorityThreshold);
			if (
				majorityThreshold !== undefined &&
				(Number.isNaN(majorityThreshold) ||
					majorityThreshold < 0 ||
					majorityThreshold > 1)
			) {
				logger.error(
					"Error: --majority-threshold must be a number between 0.0 and 1.0"
				);
				process.exit(1);
			}
			try {
				await namingCommand({
					directory,
					project: values.project,
					workspace: values.workspace,
					verbose: values.verbose,
					json: values.json,
					fix: values.fix,
					force: values.force,
					minSiblings,
					majorityThreshold,
					includeTests: values["include-tests"],
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "tidy",
		helpText: `
Usage: ${name} tidy <directory> --experimental [options]

Run a structural tidyup report by composing unused, similar, and audit.

Arguments:
  directory    Path to the project directory to scan

Options:
  --experimental         Required in 1.x to opt into the unstable tidy schema
  --json                 Output results as JSON
  --scope                Only show findings whose source file is under this path
  --out                  Write the report to a file instead of stdout
  --workspace            Scan across all workspace packages where supported
  --fix                  Apply safe fixes (dead-exports, alias-normalisation)
  --fix=<categories>     Apply comma-separated tidy fix categories
  --max-changes          Abort --fix when planned changes exceed this limit (default: 50)
  --force                Allow --fix when the git worktree is dirty
  --verbose              Show extra operational messages

Examples:
  ${name} tidy src --experimental
  ${name} tidy src --experimental --json
  ${name} tidy src --experimental --fix
  ${name} tidy src --experimental --fix=dead-exports
  ${name} tidy src --experimental --scope src/core
  ${name} tidy src --experimental --out tidy-report.json --json
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: tidy requires a <directory> argument");
				logger.error(`Run '${name} tidy --help' for usage`);
				process.exit(1);
			}
			try {
				const fixCategories =
					values.fix || values["fix-category"]
						? parseTidyFixCategories(values["fix-category"])
						: undefined;
				const maxChanges = values["max-changes"]
					? Number(values["max-changes"])
					: undefined;
				if (
					maxChanges !== undefined &&
					(!Number.isInteger(maxChanges) || maxChanges < 1)
				) {
					logger.error("Error: --max-changes must be a positive integer");
					process.exit(1);
				}
				await tidyCommand({
					directory,
					project: values.project,
					json: values.json,
					workspace: values.workspace,
					verbose: values.verbose,
					experimental: values.experimental,
					scope: values.scope,
					out: values.out,
					fix: values.fix,
					fixCategories,
					force: values.force,
					maxChanges,
					fanOutThreshold: values["fan-out-threshold"]
						? Number(values["fan-out-threshold"])
						: undefined,
					fanInThreshold: values["fan-in-threshold"]
						? Number(values["fan-in-threshold"])
						: undefined,
					exportThreshold: values["export-threshold"]
						? Number(values["export-threshold"])
						: undefined,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "audit",
		helpText: `
Usage: ${name} audit <directory> [options]

Analyze module health metrics: fan-out, fan-in, instability ratios,
and circular dependency detection.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project          Path to project directory or tsconfig.json
  --json                 Output results as JSON
  --workspace            Scan across all workspace packages
  --fan-out-threshold    Flag files with more than N imports (default: 10)
  --fan-in-threshold     Flag files with more than N consumers (default: 10)
  --export-threshold     Flag files with more than N exports (default: 8)

Metrics:
  Fan-out       Number of distinct modules a file imports
  Fan-in        Number of distinct files that import a module
  Instability   fan-out / (fan-in + fan-out) — 0 = maximally stable, 1 = maximally unstable

Examples:
  ${name} audit src
  ${name} audit . --json
  ${name} audit . --workspace
  ${name} audit src --fan-out-threshold=8 --export-threshold=5
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: audit requires a <directory> argument");
				logger.error(`Run '${name} audit --help' for usage`);
				process.exit(1);
			}
			await auditCommand({
				directory,
				project: values.project,
				json: values.json,
				workspace: values.workspace,
				fanOutThreshold: values["fan-out-threshold"]
					? Number(values["fan-out-threshold"])
					: undefined,
				fanInThreshold: values["fan-in-threshold"]
					? Number(values["fan-in-threshold"])
					: undefined,
				exportThreshold: values["export-threshold"]
					? Number(values["export-threshold"])
					: undefined,
			});
		},
	},

	{
		name: "unused",
		helpText: `
Usage: ${name} unused <directory> [options]

Find exports and files that are never imported by any other file in the project.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project    Path to project directory or tsconfig.json
  --json           Output results as JSON
  --verbose        Show detailed output
  --ignore         Glob pattern to exclude files (e.g. "*.test.ts")

Examples:
  ${name} unused src
  ${name} unused . --json
  ${name} unused src --ignore="*.test.ts"
`,
		run: async ([directory], values) => {
			if (!directory) {
				logger.error("Error: unused requires a <directory> argument");
				logger.error(`Run '${name} unused --help' for usage`);
				process.exit(1);
			}
			const { unusedCommand: cmd } = await import("./unused.ts");
			await cmd({
				directory,
				project: values.project,
				json: values.json,
				verbose: values.verbose,
				ignore: values.ignore,
			});
		},
	},
];
