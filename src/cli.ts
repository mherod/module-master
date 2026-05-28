#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { name, version } from "../package.json";
import { logger } from "./cli-logger.ts";
import type { CliValues } from "./commands/registry.ts";
import { COMMANDS } from "./commands/registry.ts";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
		verbose: { type: "boolean" },
		"dry-run": { type: "boolean", short: "n" },
		project: { type: "string", short: "p" },
		type: { type: "string", short: "t" },
		prefer: { type: "string" },
		force: { type: "boolean" },
		"no-verify": { type: "boolean" },
		fix: { type: "boolean" },
		json: { type: "boolean" },
		threshold: { type: "string" },
		"max-groups": { type: "string" },
		strict: { type: "boolean" },
		"name-threshold": { type: "string" },
		"same-name-only": { type: "boolean" },
		"skip-same-file": { type: "boolean" },
		"only-related-to": { type: "string" },
		"min-lines": { type: "string" },
		"skip-directives": { type: "boolean" },
		"skip-wrappers": { type: "boolean" },
		kinds: { type: "string" },
		group: { type: "string" },
		output: { type: "string", short: "o" },
		workspace: { type: "boolean" },
		experimental: { type: "boolean" },
		scope: { type: "string" },
		out: { type: "string" },
		bucket: { type: "string" },
		format: { type: "string" },
		"fan-out-threshold": { type: "string" },
		"fan-in-threshold": { type: "string" },
		"export-threshold": { type: "string" },
		"min-siblings": { type: "string" },
		"majority-threshold": { type: "string" },
		"include-tests": { type: "boolean" },
		"convention-threshold": { type: "string" },
		ignore: { type: "string" },
	},
	allowPositionals: true,
});

function showHelp() {
	logger.info(`
${name} v${version}

Precise TypeScript/JavaScript module refactoring tool.

Usage:
  ${name} <command> [options] [args]

Commands:
  find <query> -p <project>           Find files and exports by name
  analyze <file>                      Analyze a module's imports, exports, and references
  discover <directory>                Discover tsconfig files and project structure
  workspace <directory>               Discover pnpm/yarn/npm workspace packages
  alias <target> --prefer=<strategy>  Normalize imports to use aliases, relative paths, or shortest
  move <source> <target>              Move a module and update all references
  rename <file> <oldName> <newName>   Rename an export and update all imports
  similar <directory>                 Find similar or duplicate functions for consolidation
  extract-common <directory>           Extract duplicate functions into shared modules
  audit <directory>                    Analyze module health: fan-out, fan-in, cycles
  unused <directory>                   Find exports never imported by other files
  test-relocation <directory>          Find stranded or misnamed test files
  naming <directory>                   Audit per-directory filename casing
  tidy <directory>                     Compose unused, similar, and audit reports

Options:
  -h, --help        Show this help message
  -v, --version     Show version
  -n, --dry-run     Preview changes without modifying files
  --force           Allow mutating commands when the git worktree has uncommitted changes
  -p, --project     Path to project directory or tsconfig.json
  -t, --type        Filter type for find command (file, export, all)
  --prefer          Strategy for alias command (alias, relative, shortest)
  --no-verify       Disable type checking verification (enabled by default)
  --verbose         Enable verbose output
  --json            Output results as JSON
  --threshold       Similarity threshold for similar command (0.0–1.0, default 0.8)
  --max-groups      Maximum number of groups to display (default: 10)
  --strict          Exit with error if similar functions are found (for CI/hooks)
  --name-threshold  Name similarity threshold for similar command (0.0–1.0)
  --same-name-only  Only group functions with identical names (similar command)
  --skip-same-file  Skip groups where all functions are in the same file
  --only-related-to Only show groups related to a file or folder path/glob
  --min-lines       Exclude functions with fewer body lines (filters thin wrappers)
  --skip-directives Skip functions with compile-time directives (use server, etc.)
  --skip-wrappers   Skip thin wrapper functions (single return + call expression)
  --kinds           Comma-separated kinds for similar command: function,type,interface
  --bucket          Filter by similarity bucket: exact, high, medium (similar command)
  --format          Output format: compact (similar command)
  --workspace       Scan across all workspace packages (discover, similar, and other commands)
  --experimental    Opt into experimental commands and schemas
  --scope           Limit report findings to a source subtree
  --out             Write command output to a file
  --fan-out-threshold  Flag files with more than N imports (default: 10, audit command)
  --fan-in-threshold   Flag files with more than N consumers (default: 10, audit command)
  --export-threshold   Flag files with more than N exports (default: 8, audit command)
  --min-siblings       Minimum files in a directory before naming audit (default: 3)
  --majority-threshold Required filename casing majority for naming audit (default: 0.6)
  --include-tests      Include *.test.* and *.spec.* files in naming audit
  --convention-threshold Required __tests__ majority for test relocation (default: 0.7)
  --fix                Attempt command fix mode where supported
  --ignore          Glob pattern to exclude files (unused command, e.g. "*.test.ts")

Examples:
  ${name} find Entity -p /path/to/project
  ${name} analyze src/utils/helpers.ts
  ${name} alias src --prefer=alias --dry-run
  ${name} move src/old/file.ts src/new/file.ts --dry-run
  ${name} rename src/components/Button.tsx Button PrimaryButton
  ${name} similar src --json
`);
}

function showVersion() {
	logger.info(`${name} v${version}`);
}

async function main() {
	if (values.help && positionals.length === 0) {
		showHelp();
		process.exit(0);
	}

	if (values.version) {
		showVersion();
		process.exit(0);
	}

	const [command, ...args] = positionals;

	if (values.help && command) {
		const cmd = COMMANDS.find((c) => c.name === command);
		if (cmd) {
			logger.info(cmd.helpText);
		} else {
			showHelp();
		}
		process.exit(0);
	}

	if (!command) {
		showHelp();
		return;
	}

	const cmd = COMMANDS.find((c) => c.name === command);
	if (!cmd) {
		logger.error(`Unknown command: ${command}`);
		showHelp();
		process.exit(1);
	}

	await cmd.run(args, values as CliValues);
}

main().catch((error) => {
	logger.error(String(error));
	process.exit(1);
});
