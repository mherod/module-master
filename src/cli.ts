#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { name, version } from "../package.json";
import { analyzeCommand } from "./commands/analyze.ts";
import { moveCommand } from "./commands/move.ts";
import { renameCommand } from "./commands/rename.ts";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
		verbose: { type: "boolean" },
		"dry-run": { type: "boolean", short: "n" },
		project: { type: "string", short: "p" },
	},
	allowPositionals: true,
});

function showHelp() {
	console.log(`
${name} v${version}

Precise TypeScript/JavaScript module refactoring tool.

Usage:
  ${name} <command> [options] [args]

Commands:
  move <source> <target>              Move a module and update all references
  rename <file> <oldName> <newName>   Rename an export and update all imports
  analyze <file>                      Analyze a module's imports, exports, and references

Options:
  -h, --help      Show this help message
  -v, --version   Show version
  -n, --dry-run   Preview changes without modifying files
  -p, --project   Path to project directory or tsconfig.json
  --verbose       Enable verbose output

Examples:
  ${name} analyze src/utils/helpers.ts
  ${name} move src/old/file.ts src/new/file.ts --dry-run
  ${name} rename src/components/Button.tsx Button PrimaryButton
`);
}

function showVersion() {
	console.log(`${name} v${version}`);
}

function showCommandHelp(command: string) {
	switch (command) {
		case "move":
			console.log(`
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
			console.log(`
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
			console.log(`
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
			if (!source || !target) {
				console.error("Error: move requires <source> and <target> arguments");
				console.error(`Run '${name} move --help' for usage`);
				process.exit(1);
			}
			await moveCommand({
				source,
				target,
				dryRun: values["dry-run"],
				verbose: values.verbose,
				project: values.project,
			});
			break;
		}

		case "rename": {
			const [file, oldName, newName] = args;
			if (!file || !oldName || !newName) {
				console.error(
					"Error: rename requires <file>, <oldName>, and <newName> arguments",
				);
				console.error(`Run '${name} rename --help' for usage`);
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
				console.error("Error: analyze requires a <file> argument");
				console.error(`Run '${name} analyze --help' for usage`);
				process.exit(1);
			}
			await analyzeCommand({
				file,
				verbose: values.verbose,
				project: values.project,
			});
			break;
		}

		case undefined:
			showHelp();
			break;

		default:
			console.error(`Unknown command: ${command}`);
			showHelp();
			process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
