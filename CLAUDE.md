# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

resect is a CLI tool for precise TypeScript/JavaScript module refactoring. It moves files, renames exports, and updates all import references across a codebase using the TypeScript Compiler API for AST-level precision.

## Commands

```bash
pnpm install         # Install dependencies
pnpm test            # Run tests (uses bun as runtime)
pnpm run lint        # Lint and format with Biome
pnpm run typecheck   # Type check with tsc
pnpm run dev         # Run CLI in development
pnpm run build       # Compile to standalone binary
```

Run a single test file:
```bash
bun test src/cli.test.ts
```

**Package management vs runtime:** pnpm is the package manager (`pnpm install`, `pnpm publish`). Bun is the runtime (`bun test`, `bun run src/cli.ts`).

## Safe File Deletion

When asked to delete files, prefer moving them to macOS Trash instead of permanently deleting them.

DON'T: `rm -rf <path>`
DO: `mv <path> ~/.Trash/`

## CLI Usage

```bash
bun src/cli.ts find <query> -p <project>           # Find files and exports by name
bun src/cli.ts analyze <file>                      # Analyze imports/exports/references
bun src/cli.ts discover <directory>                # Discover tsconfig files and project structure
bun src/cli.ts alias <target> --prefer=<strategy>  # Normalize import paths
bun src/cli.ts move <source> <target> [--dry-run]  # Move file, update all imports
bun src/cli.ts rename <file> <old> <new> [--dry-run]  # Rename export, update all imports
```

Use `-p <project>` to specify a project directory for find/analyze:
```bash
bun src/cli.ts find Entity -p /path/to/project              # Find Entity files and exports
bun src/cli.ts find User -p . --type export                 # Find only User exports
bun src/cli.ts analyze /path/to/file.ts -p /path/to/project
bun src/cli.ts alias src --prefer=alias                     # Normalize to tsconfig aliases
bun src/cli.ts alias src --prefer=shortest --no-verify     # Pick shortest path, skip verification
```

## Architecture

The codebase uses the TypeScript Compiler API (`typescript` package) for parsing and analyzing TypeScript/JavaScript files. This enables precise handling of all import/export variants, path aliases, and barrel files.

### Core Modules (`src/core/`)

- **project.ts** - Loads tsconfig.json, extracts path aliases, creates TS programs
- **tsconfig-discovery.ts** - Smart discovery of all tsconfig files, handles monorepos and project references
- **scanner.ts** - AST traversal to extract all imports/exports from a source file
- **resolver.ts** - Module path resolution, alias matching, relative path calculation, cross-package import resolution
- **graph.ts** - Builds dependency graph (imports/importedBy maps) for the entire project
- **updater.ts** - Applies text changes to update import specifiers in files, adds exports to destination barrels
- **verify.ts** - Type checking verification using `tsc --noEmit` before/after changes
- **workspace.ts** - Discovers pnpm/yarn/npm workspace packages, barrel files, and tsconfig paths
- **text-changes.ts** - Shared utilities for applying text edits: `TextChange` interface, `applyTextChanges()`, `deduplicateChanges()`
- **constants.ts** - Shared constants and patterns: `TSC_ERROR_PATTERN`, `EXPORT_STATEMENT_PATTERN`, `removeExtension()`

### Commands (`src/commands/`)

- **find.ts** - Search for files and exports by name across the project
- **analyze.ts** - Deep analysis of a module's imports, exports, and references
- **discover.ts** - Map all tsconfig files and their ownership
- **workspace.ts** - Discover monorepo workspace packages and their structure
- **alias.ts** - Normalize import paths using aliases, relative paths, or shortest option
- **move.ts** - Move files and update all references (supports cross-package moves)
- **rename.ts** - Rename exports and update all imports

### Data Flow

1. **Load project** → Parse tsconfig.json, extract compiler options and path aliases
2. **Build graph** → Scan all project files, create import/importedBy maps
3. **Find references** → Query graph for files importing target module
4. **Calculate changes** → Determine new import specifiers based on operation
5. **Apply updates** → Modify source text at precise AST node positions

### Key Types (`src/types.ts`)

- `ModuleReference` - Represents an import/export with source location, specifier, and bindings
- `ReferenceType` - Discriminates import variants (named, namespace, dynamic, require, jest-mock)
- `ProjectConfig` - tsconfig data including path aliases, include/exclude patterns, resolved files
- `TsConfigInfo` - Discovery result for a single tsconfig (in tsconfig-discovery.ts)
- `DependencyGraph` - Maps files to their imports and reverse references

## Bun Runtime

This project uses Bun exclusively. Use `Bun.file()` for file I/O instead of node:fs.

## TypeScript Compiler API

When calling `node.getStart()` on AST nodes, always pass the sourceFile parameter: `node.getStart(sourceFile)`. Without it, the method fails with "undefined is not an object" in Bun's runtime. `node.getEnd()` does not accept parameters.

DON'T: `node.getStart()` — fails at runtime
DO: `node.getStart(sourceFile)` — works correctly

When obtaining line/character positions, the pattern is:
```typescript
const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)  // Always pass sourceFile
);
```

## tsconfig Discovery

The `tsconfig-discovery.ts` module handles complex project structures:

- **Monorepos**: Discovers all tsconfig.json files recursively, skipping node_modules/dist/build/.git
- **Solution-style configs**: Detects configs with `references` but no `compilerOptions` (project references)
- **File ownership**: Maps each file to its owning tsconfig based on include/exclude patterns
- **Extends chains**: Tracks inheritance relationships between configs

When loading a project with a target file, use `loadProject(tsconfigPath, targetFile)` to automatically find the most specific config that includes that file.

## Scanner Coverage

The scanner (`src/core/scanner.ts`) detects these reference types:
- ESM imports: default, named, namespace, side-effect, dynamic `import()`
- CommonJS: `require()`, `require.resolve()`
- Re-exports: `export { x } from`, `export * from`, `export * as x from`
- Test mocks: `jest.mock()`, `vi.mock()`, `vitest.mock()`, including `doMock`/`unmock` variants

DON'T: Modify string literals in fs/Bun.file calls—these are not module paths and cannot be safely resolved.

## Find Command

The `find` command (`src/commands/find.ts`) searches for files and exports across a project:

- **Discovery-based**: Uses `discoverProject()` to get all files from tsconfig ownership
- **Case-insensitive**: Searches are case-insensitive with partial matching
- **Dual search**: Searches both filenames and export names simultaneously
- **Smart sorting**: Exact matches appear first, then alphabetical order
- **Type filtering**: Use `--type file|export|all` to filter results

The command scans exports by parsing each TypeScript/JavaScript file with the TS Compiler API and extracting exports using `scanExports()`. Files that fail to parse are silently skipped.

## Alias Command

The `alias` command (`src/commands/alias.ts`) normalizes import specifiers:

- **Three strategies**: `--prefer=alias` (use tsconfig paths), `--prefer=relative` (use ./... paths), `--prefer=shortest` (pick shorter option)
- **Batch processing**: Works on single files or entire directories
- **External package filtering**: Skips node_modules and any import that resolves outside the project root
- **Processes all in-project imports**: Normalizes both relative (`./foo`) and alias (`@/foo`) imports — does not require the specifier to start with `.`
- **Verification enabled by default**: Runs `tsc --noEmit` before and after to catch breaking changes
- **Simple text replacement**: Uses regex-based replacement on file contents
- **Delegates to resolver.ts**: Uses `calculateRelativeSpecifier()` and `findAliasForPath()` from `src/core/resolver.ts` rather than private copies

DON'T: Apply alias command to files with complex dynamic imports or computed module paths—verification will catch issues but manual review may be needed.

## Type Checking Verification

The `verify.ts` module provides safety for refactoring operations:

- **Before/after comparison**: Runs `tsc --noEmit -p <tsconfig>` before and after changes
- **Error diffing**: Compares error output to identify new issues introduced by changes
- **Exit on failure**: Commands exit with error code if new type errors are detected
- **Bonus tracking**: Reports errors fixed by the refactoring as a side effect
- **Enabled by default**: Use `--no-verify` to skip for faster execution (risky)

Verification spawns `tsc` as a subprocess using `spawnSync` and parses error output. Errors are matched as lines containing `: error TS`. The tool tracks which errors existed before, which are new, and which were fixed.

`runTypeCheck(project)` is exported from `verify.ts` and reused by `move.ts`.

`collectUnresolvableDiagnostics(project)` scans all project files for unresolvable imports and returns `UnresolvableDiagnosticWithFile[]` (each entry has `file`, `specifier`, `line`, `diagnostic`). Use this for project-wide unresolvable import reporting. `VerificationResult.unresolvableDiagnostics` exposes these after a verify pass.

DON'T: Duplicate `runTypeCheck` logic in command files. Import from `verify.ts`.

DON'T: Duplicate unresolvable-import scanning across command files. Call `collectUnresolvableDiagnostics(project)` from `verify.ts`.

## Conflict Detection

All three mutating commands (`move`, `rename`, `alias`) perform conflict detection before applying changes. The read-only commands (`find`, `discover`, `workspace`, `analyze`) have no write operations and need no conflict guards.

### Rename Conflict Detection (`src/commands/rename.ts`)

Before renaming an export, `renameSymbol()` checks:
1. **Source file export conflict**: Does `newName` already exist as an export in the source file? Uses `findExport(sourceAst, newName)`.
2. **Importer binding conflict**: For each file importing the old symbol without an alias (`import { oldName }`), does that file already declare a local binding named `newName`? Uses `hasLocalBinding()`.

### Move Conflict Detection (`src/commands/move.ts`)

Before moving a file, `moveModule()` checks:
1. **Destination barrel conflict**: If a destination barrel exists, do any of the moved file's export names already exist in the barrel's exports? Parses the barrel with `scanExports()`.
2. **Importer binding conflict**: For each file importing from the moved module with non-aliased bindings, does that file already declare a local binding with the same name? Uses `hasLocalBinding()`.

### Alias Conflict Detection (`src/commands/alias.ts`)

Before normalizing an import specifier, `normalizeImports()` checks:
- **Duplicate specifier with overlapping bindings**: Would the new specifier match an existing import in the same file that already imports a binding with the same local name? Skips the change and warns instead of creating duplicate imports.

### `hasLocalBinding()` Helper

Both `move.ts` and `rename.ts` implement `hasLocalBinding()` — an AST walker that checks if a file already declares a given name via variable/function/class/type/interface/enum declarations or import bindings (excluding the import being changed). When adding new mutating commands, include equivalent conflict detection.

DON'T: Add a new mutating command without conflict detection. All commands that write files must check for export name and binding conflicts before applying changes.

## Workspace Discovery

The `workspace` command (`src/commands/workspace.ts`) discovers monorepo structure:

```bash
bun src/cli.ts workspace <directory>          # Discover workspace packages
bun src/cli.ts workspace <directory> --json   # JSON output for tooling
bun src/cli.ts workspace <directory> --verbose # Show detailed export maps
```

The `discoverWorkspace()` function in `src/core/workspace.ts` finds:
- **pnpm-workspace.yaml** - Parses packages array for workspace patterns
- **package.json workspaces** - Supports yarn/npm workspaces field (array or {packages: []})
- **Per-package metadata**: name, main/module/types entrypoints, exports map, dependencies
- **Barrel files**: index.ts/index.js files that contain at least one export statement
- **tsconfig paths**: tsconfig.json for each package

### Barrel File Detection

Barrel files must meet two criteria:
1. Named `index.ts`, `index.tsx`, or `index.js`
2. Contain at least one export statement (checked via regex: `/\bexport\s+(\*|{|default|const|let|var|function|class|type|interface|enum)\b/`)

DON'T: Assume any index.ts is a barrel file. Files without exports are not barrels.

### Directory Existence Checks

When checking if a directory exists (e.g., detecting `src/` directories), `Bun.file().exists()` returns false for directories. Use `node:fs/promises` `stat()` as fallback:

```typescript
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) return true;
    const { stat } = await import("node:fs/promises");
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
```

## Cross-Package Refactoring

The move command supports cross-package refactoring in monorepos:

```bash
bun src/cli.ts move apps/web/src/utils/foo.ts packages/shared/src/foo.ts --dry-run
```

### How It Works

1. **Workspace discovery**: Automatically discovers workspace packages at move start
2. **Package detection**: Identifies source and destination packages using `findPackageForPath()`
3. **Import updates**: Uses package name (e.g., `@scope/package`) instead of relative paths for cross-package moves
4. **Destination barrel update**: Adds `export * from "./foo"` to the destination package's index.ts

### Barrel Export Insertion

When moving to a new package, `addExportToDestinationBarrel()`:
- Calculates relative path from barrel to moved file
- Generates `export * from "./relative-path"` statement
- Inserts after the last existing export (or at end if no exports)
- Skips if export already exists

### Import Path Resolution

For cross-package moves, `findCrossPackageImport()` resolves the optimal import path:
- If file is in package's `src/` directory and being added to barrel → use package name only (e.g., `@scope/pkg`)
- If package.json exports field matches the subpath → use that export path
- Fallback: package name + relative subpath

DON'T: Use relative paths like `../../../packages/foo/src/bar` for cross-package imports. Always prefer package imports.

### Barrel Re-export Handling for Cross-Package Moves

When moving files across packages, source barrel re-exports (`export * from "./moved-file"`) must be **removed entirely**, not changed to `export * from "@scope/package"`. Changing to a package import would pull in ALL exports from that package, causing duplicate export conflicts.

The `updateBarrelExports()` function in `updater.ts` handles this:
- Resolves each export declaration's specifier to check if it points to the moved file
- For cross-package moves: removes the re-export line entirely
- For same-package moves: updates the path normally

Similarly, `updateFileReferences()` detects `export-all`, `export-from`, and `export-all-as` reference types and removes them for cross-package moves instead of updating the specifier.

DON'T: Change `export * from "./moved-file"` to `export * from "@scope/package"` for cross-package moves. This causes TS2308 errors like "Module has already exported a member named X".

### Import Splitting for Mixed Barrel Imports

When files import multiple things from a barrel (`import { a, b } from "@/lib/utils"`) and only some bindings come from the moved file, split the import into two statements:

```typescript
// Before: import { formatDate, makeAuthorUrl } from "@/lib/utils"
// After (if formatDate moved to @plugg/shared-utils):
import { formatDate } from "@plugg/shared-utils";
import { makeAuthorUrl } from "@/lib/utils";
```

The `updateFileReferences()` function:
1. Scans the moved file's exports using `scanExports()`
2. Compares each import's bindings against the moved exports
3. If mixed bindings: creates `ImportSplitChange` to replace single import with two
4. If all bindings are moved: updates specifier normally
5. If no bindings are moved: skips the reference

DON'T: Update entire import specifiers to new package when only some bindings come from the moved file. This causes TS2305 errors like "Module has no exported member X".

### Move Command File Handling

The move command must handle all code paths for file copying:
- Files with internal imports that need updating
- Files with internal imports that don't change
- Files with NO imports (utility functions, constants)
- Files that fail to parse

Use a `fileMoved` flag pattern to ensure the file copy always happens regardless of which code path executes. The fallback at the end catches any path that didn't move the file.

### DependencyGraph Barrel Tracking

The `DependencyGraph` interface includes `barrelReExports: Map<string, string[]>` to track which files each barrel actually re-exports via `export ... from` statements. This distinguishes actual re-exports from regular imports within barrel files.

DON'T: Use `graph.imports` to find barrel re-exports. Files that a barrel imports for internal use are not re-exports. Use `graph.barrelReExports` instead.

## Shared Utilities

### Text Changes (`src/core/text-changes.ts`)

Use the shared `TextChange` interface and `applyTextChanges()` for source code modifications:

```typescript
import { type TextChange, applyTextChanges, deduplicateChanges } from "./text-changes.ts";

const changes: TextChange[] = [
    { start: 10, end: 20, newText: "replacement" }
];
const uniqueChanges = deduplicateChanges(changes);
const newContent = applyTextChanges(sourceFile.text, uniqueChanges);
```

DON'T: Implement text change application logic inline. Use `applyTextChanges()` from the shared module.

### Constants (`src/core/constants.ts`)

Use shared constants instead of inline patterns:

- `TSC_ERROR_PATTERN` - String `": error TS"` for detecting TypeScript errors
- `EXPORT_STATEMENT_PATTERN` - Regex for detecting export statements in barrel files
- `removeExtension()` - Strips `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` extensions from paths
- `TS_JS_EXTENSIONS` - Regex `/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/` — the full extension pattern including modern variants
- `TS_JS_EXTENSION_PATTERN` - Narrow legacy regex `/\.[tj]sx?$/` that misses `.mts/.cts/.mjs/.cjs`

DON'T: Use inline regex like `/\.[tj]sx?$/` or `": error TS"` strings. Import from `constants.ts`.

DON'T: Use `TS_JS_EXTENSION_PATTERN` for extension stripping in new code — it misses `.mts/.cts/.mjs/.cjs`. Use `TS_JS_EXTENSIONS` or `removeExtension()` instead.

## Biome Linter Behavior

Biome runs as a PostToolUse hook after every file edit and auto-removes unused imports. This has one important implication when adding new imports:

**When adding a new import to a file, include its first usage site in the same Edit call.** If you add an import in one Edit and its usage in a separate Edit, Biome will strip the import between the two calls, causing a type error on the next Edit.

```typescript
// WRONG: two separate Edits
// Edit 1: adds import — Biome strips it because not yet used
import { findAliasForPath } from "../core/resolver.ts";

// Edit 2: adds usage — finds import missing, type error
const alias = findAliasForPath(toFile, project);
```

```typescript
// CORRECT: one Edit covering both import and first usage
import { findAliasForPath } from "../core/resolver.ts";
// ... other code ...
const alias = findAliasForPath(toFile, project);
```

DON'T: Add an import in one Edit and its usage in a subsequent Edit. Biome will strip the import before the usage lands.

## Async Function Guidelines

Command handlers in `src/commands/` should only be `async` if they contain `await` expressions. The `analyzeCommand()` and `discoverCommand()` functions are synchronous—no `async` keyword needed.

DON'T: Mark functions as `async` without using `await`. This creates misleading API contracts and unnecessary Promise wrapping.
