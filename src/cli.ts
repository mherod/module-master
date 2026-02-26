#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { name, version } from "../package.json";
import { logger } from "./cli-logger.ts";
import { aliasCommand } from "./commands/alias.ts";
import { analyzeCommand } from "./commands/analyze.ts";
import { discoverCommand } from "./commands/discover.ts";
import { findCommand } from "./commands/find.ts";
import { moveCommand } from "./commands/move.ts";
import { renameCommand } from "./commands/rename.ts";
import { workspaceCommand } from "./commands/workspace.ts";

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
		"no-verify": { type: "boolean" },
		json: { type: "boolean" },
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

Options:
  -h, --help        Show this help message
  -v, --version     Show version
  -n, --dry-run     Preview changes without modifying files
  -p, --project     Path to project directory or tsconfig.json
  -t, --type        Filter type for find command (file, export, all)
  --prefer          Strategy for alias command (alias, relative, shortest)
  --no-verify       Disable type checking verification (enabled by default)
  --verbose         Enable verbose output

Examples:
  ${name} find Entity -p /path/to/project
  ${name} analyze src/utils/helpers.ts
  ${name} alias src --prefer=alias --dry-run
  ${name} move src/old/file.ts src/new/file.ts --dry-run
  ${name} rename src/components/Button.tsx Button PrimaryButton
`);
}

function showVersion() {
	logger.info(`${name} v${version}`);
}

function showCommandHelp(command: string) {
	switch (command) {
		case "move":
			logger.info(`
Usage: ${name} move <source> <target> [options]

Move a TypeScript/JavaScript module to a new location and update all references.

Arguments:
  source    Path to the file to move
  target    Destination path for the file

Options:
  -n, --dry-run   Preview changes without modifying files
  --verbose       Show detailed information about each change

Features:
  • Updates all import statements referencing the moved file
  • Preserves path aliases when possible
  • Updates barrel file re-exports
  • Handles dynamic imports and require() calls
  • Updates internal imports within the moved file

Examples:
  ${name} move src/utils/old.ts src/helpers/new.ts
  ${name} move src/components/Button.tsx src/ui/Button.tsx --dry-run
`);
			break;
		case "rename":
			logger.info(`
Usage: ${name} rename <file> <oldName> <newName> [options]

Rename an exported symbol (class, function, component, type) and update all imports.

Arguments:
  file       Path to the file containing the export
  oldName    Current name of the export
  newName    New name for the export

Options:
  -n, --dry-run   Preview changes without modifying files
  --verbose       Show detailed information about each change

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
`);
			break;
		case "analyze":
			logger.info(`
Usage: ${name} analyze <file> [options]

Analyze a module's imports, exports, and references throughout the codebase.

Arguments:
  file    Path to the file to analyze

Options:
  --verbose    Show detailed reference information

Output includes:
  • All exports from the file
  • All imports used by the file
  • All files that reference this module
  • Barrel files that re-export this module

Examples:
  ${name} analyze src/utils/helpers.ts
  ${name} analyze src/components/Button.tsx --verbose
`);
			break;
		case "discover":
			logger.info(`
Usage: ${name} discover <directory> [options]

Discover all tsconfig.json files in a directory and understand project structure.

Arguments:
  directory    Path to the project directory to scan

Options:
  --verbose    Show detailed file ownership and path aliases

Output includes:
  • All tsconfig.json files found
  • Include/exclude patterns for each config
  • Project references (for solution-style configs)
  • File ownership map (which config controls each file)

Examples:
  ${name} discover .
  ${name} discover /path/to/project --verbose
`);
			break;
		case "find":
			logger.info(`
Usage: ${name} find <query> -p <project> [options]

Find files and exports by name within a project.

Arguments:
  query    Name to search for (case-insensitive, partial match)

Options:
  -p, --project   Path to project directory (required)
  -t, --type      Filter: file, export, or all (default: all)
  --verbose       Show helpful tips for next steps

Output includes:
  • Files matching the query by filename
  • Exports matching the query by name
  • Line numbers for each export

Examples:
  ${name} find Entity -p /path/to/project
  ${name} find User -p . --type export
  ${name} find config -p . --type file --verbose
`);
			break;
		case "alias":
			logger.info(`
Usage: ${name} alias <target> --prefer=<strategy> [options]

Normalize import specifiers to use path aliases, relative paths, or the shortest option.

Arguments:
  target    File or directory to process

Options:
  --prefer        Strategy: alias, relative, or shortest (required)
  -p, --project   Path to project directory or tsconfig.json
  -n, --dry-run   Preview changes without modifying files
  --no-verify     Disable type checking verification (enabled by default)
  --verbose       Show detailed changes

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
`);
			break;
		default:
			showHelp();
	}
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
		showCommandHelp(command);
		process.exit(0);
	}

	switch (command) {
		case "move": {
			const [source, target] = args;
			if (!(source && target)) {
				logger.error("Error: move requires <source> and <target> arguments");
				logger.error(`Run '${name} move --help' for usage`);
				process.exit(1);
			}
			await moveCommand({
				source,
				target,
				dryRun: values["dry-run"],
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
			});
			break;
		}

		case "rename": {
			const [file, oldName, newName] = args;
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
				verbose: values.verbose,
				project: values.project,
			});
			break;
		}

		case "analyze": {
			const [file] = args;
			if (!file) {
				logger.error("Error: analyze requires a <file> argument");
				logger.error(`Run '${name} analyze --help' for usage`);
				process.exit(1);
			}
			await analyzeCommand({
				file,
				verbose: values.verbose,
				project: values.project,
			});
			break;
		}

		case "discover": {
			const [directory] = args;
			if (!directory) {
				logger.error("Error: discover requires a <directory> argument");
				logger.error(`Run '${name} discover --help' for usage`);
				process.exit(1);
			}
			await discoverCommand({
				directory,
				verbose: values.verbose,
			});
			break;
		}

		case "workspace": {
			const [directory] = args;
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
			break;
		}

		case "find": {
			const [query] = args;
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
			});
			break;
		}

		case "alias": {
			const [target] = args;
			if (!target) {
				logger.error("Error: alias requires a <target> argument");
				logger.error(`Run '${name} alias --help' for usage`);
				process.exit(1);
			}
			if (!values.prefer) {
				logger.error("Error: alias requires --prefer option");
				logger.error(`Run '${name} alias --help' for usage`);
				process.exit(1);
			}
			const prefer = values.prefer as "alias" | "relative" | "shortest";
			if (!["alias", "relative", "shortest"].includes(prefer)) {
				logger.error(
					"Error: --prefer must be 'alias', 'relative', or 'shortest'"
				);
				process.exit(1);
			}
			await aliasCommand({
				target,
				prefer,
				dryRun: values["dry-run"],
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
			});
			break;
		}

		case undefined:
			showHelp();
			break;

		default:
			logger.error(`Unknown command: ${command}`);
			showHelp();
			process.exit(1);
	}
}

main().catch((error) => {
	logger.error(String(error));
	process.exit(1);
});
