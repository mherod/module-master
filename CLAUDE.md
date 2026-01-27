# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

module-master is a CLI tool for precise TypeScript/JavaScript module refactoring. It moves files, renames exports, and updates all import references across a codebase using the TypeScript Compiler API for AST-level precision.

## Commands

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run lint         # Lint and format with Biome
bun run typecheck    # Type check with tsc
bun run dev          # Run CLI in development
bun run build        # Compile to standalone binary
```

Run a single test file:
```bash
bun test src/cli.test.ts
```

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
- **External package filtering**: Automatically skips node_modules and external imports
- **Verification enabled by default**: Runs `tsc --noEmit` before and after to catch breaking changes
- **Simple text replacement**: Uses regex-based replacement on file contents

DON'T: Apply alias command to files with complex dynamic imports or computed module paths—verification will catch issues but manual review may be needed.

## Type Checking Verification

The `verify.ts` module provides safety for refactoring operations:

- **Before/after comparison**: Runs `tsc --noEmit -p <tsconfig>` before and after changes
- **Error diffing**: Compares error output to identify new issues introduced by changes
- **Exit on failure**: Commands exit with error code if new type errors are detected
- **Bonus tracking**: Reports errors fixed by the refactoring as a side effect
- **Enabled by default**: Use `--no-verify` to skip for faster execution (risky)

Verification spawns `tsc` as a subprocess using `spawnSync` and parses error output. Errors are matched as lines containing `: error TS`. The tool tracks which errors existed before, which are new, and which were fixed.

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

### DependencyGraph Barrel Tracking

The `DependencyGraph` interface includes `barrelReExports: Map<string, string[]>` to track which files each barrel actually re-exports via `export ... from` statements. This distinguishes actual re-exports from regular imports within barrel files.

DON'T: Use `graph.imports` to find barrel re-exports. Files that a barrel imports for internal use are not re-exports. Use `graph.barrelReExports` instead.
