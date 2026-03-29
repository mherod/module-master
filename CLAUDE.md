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
bun src/cli.ts audit <directory>                     # Module health: fan-out, fan-in, cycles
bun src/cli.ts unused <directory>                    # Find exports never imported by other files
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
- **similarity-algorithms.ts** - Pure stateless algorithm primitives (bigrams, Jaccard, name similarity, normalization). No I/O, no async — unit-testable without mocking
- **source-file.ts** - `parseSourceFile()` and `withSourceFile()` (file-path and program overloads, both invoke a callback with the parsed source file)
- **scanner.ts** - AST traversal to extract all imports/exports from a source file; scanner functions take `ts.SourceFile` directly (use `source-file.ts` to obtain one)
- **resolver.ts** - Module path resolution, alias matching, relative path calculation, cross-package import resolution
- **graph.ts** - Builds dependency graph (imports/importedBy maps) for the entire project
- **updater.ts** - Applies text changes to update import specifiers in files, adds exports to destination barrels
- **verify.ts** - Type checking verification using `tsc --noEmit` before/after changes
- **workspace.ts** - Discovers pnpm/yarn/npm workspace packages, barrel files, and tsconfig paths
- **text-changes.ts** - Shared utilities for applying text edits: `TextChange` interface, `applyTextChanges()`, `deduplicateChanges()`
- **constants.ts** - Shared constants and patterns: `TSC_ERROR_PATTERN`, `EXPORT_STATEMENT_PATTERN`, `removeExtension()`
- **git.ts** - Git worktree safety: `isWorktreeDirty()` and `ensureCleanWorktree()` for dirty-worktree guard

### Commands (`src/commands/`)

- **find.ts** - Search for files and exports by name across the project
- **analyze.ts** - Deep analysis of a module's imports, exports, and references
- **discover.ts** - Map all tsconfig files and their ownership
- **workspace.ts** - Discover monorepo workspace packages and their structure
- **alias.ts** - Normalize import paths using aliases, relative paths, or shortest option
- **move.ts** - Move files and update all references (supports cross-package moves)
- **rename.ts** - Rename exports and update all imports
- **audit.ts** - Module health metrics: fan-out, fan-in, instability, cycle detection

### Data Flow

1. **Load project** → Parse tsconfig.json, extract compiler options and path aliases
2. **Build graph** → Scan all project files, create import/importedBy maps
3. **Find references** → Query graph for files importing target module
4. **Calculate changes** → Determine new import specifiers based on operation
5. **Apply updates** → Modify source text at precise AST node positions

### Key Types

Types are organised into per-domain modules under `src/types/`. Root `src/types.ts` retains only cross-cutting infrastructure types and re-exports the domain types for backward compatibility.

- **`src/types.ts`** - `ProjectConfig`, `ProjectReference` (plus re-exports from domain modules)
- **`src/types/graph.ts`** - `ModuleReference`, `ReferenceType`, `ImportBinding`, `BarrelExport`, `BarrelExportEntry`
- **`src/types/move.ts`** - `MoveOperation`, `MoveResult`, `UpdatedReference`, `MoveError`
- **`src/types/analysis.ts`** - `AnalysisResult`, `ExportInfo`
- **`src/types/commands.ts`** - `ReadOnlyCommandOptions` (base for find, analyze, discover, audit), `MutatingCommandOptions` (base for move, rename, alias, extract-common)
- **`src/types/similar.ts`** - `FunctionInfo`, `SimilarityBucket`, `SimilarityGroup`, `SimilarityReport`

Import from the specific domain module, not the root barrel:

```typescript
// ✓ preferred — explicit domain import
import type { ModuleReference } from "../types/graph.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ProjectConfig } from "../types.ts"; // cross-cutting infra stays at root

// also works (backward compat) but obscures the domain
import type { ModuleReference, ExportInfo } from "../types.ts";
```

Other types:
- `TsConfigInfo` - Discovery result for a single tsconfig (in tsconfig-discovery.ts)
- `DependencyGraph` - Maps files to their imports and reverse references (in core/graph.ts)

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

## AST Node Coverage

Support matrix for TypeScript AST node kinds. See also [README](./README.md) AST-level precision claim.

### `scanModuleReferences()`

| Node kind | Pattern | Output |
|---|---|---|
| `ImportDeclaration` (no clause) | `import './x'` | `import-side-effect` |
| `ImportDeclaration` (default) | `import x from './x'` | `import` |
| `ImportDeclaration` (named) | `import { x } from './x'` | `import-named` |
| `ImportDeclaration` (namespace) | `import * as x from './x'` | `import-namespace` |
| `ExportDeclaration` (wildcard) | `export * from './x'` | `export-all` |
| `ExportDeclaration` (namespace) | `export * as x from './x'` | `export-all-as` |
| `ExportDeclaration` (named) | `export { x } from './x'` | `export-from` |
| `CallExpression` (dynamic import) | `import('./x')` | `import-dynamic` |
| `CallExpression` (`require`) | `require('./x')` | `require` |
| `CallExpression` (`require.resolve`) | `require.resolve('./x')` | `require-resolve` |
| `CallExpression` (mock) | `jest.mock('./x')`, `vi.mock('./x')` | `jest-mock` |

Out of scope: non-string-literal specifiers (`require(someVar)`), `import.meta.url`, `export namespace`.

### `scanExports()`

| Node kind | Pattern | Notes |
|---|---|---|
| `VariableStatement` + export | `export const x = ...` | Identifier bindings only; destructured names not extracted |
| `FunctionDeclaration` + export | `export function foo() {}` | default → `type: "default"` |
| `ClassDeclaration` + export | `export class Foo {}` | default → `type: "default"` |
| `TypeAliasDeclaration` + export | `export type Foo = ...` | `isType: true` |
| `InterfaceDeclaration` + export | `export interface Foo {}` | `isType: true` |
| `EnumDeclaration` + export | `export enum Foo {}` | `isType: false` |
| `ExportAssignment` | `export default expr` | `type: "default"` |
| `ExportDeclaration` (no specifier) | `export { x, y }` | Local re-export only |

Out of scope: `export namespace`, destructured variable exports.

### `scanBarrelExports()`

| Pattern | Type |
|---|---|
| `export * from './x'` | `all` |
| `export * as x from './x'` | `all-as` |
| `export { x, y } from './x'` | `named` (per binding) |

### `getNameNode()`

Returns `node.name` for: `FunctionDeclaration`, `ClassDeclaration`, `TypeAliasDeclaration`, `InterfaceDeclaration`, `EnumDeclaration`. `VariableStatement`/`VariableDeclaration` → first declaration's identifier only. `ExportAssignment` → `node.expression`. Returns `null` for: `MethodDeclaration`, `ConstructorDeclaration`, accessor declarations, namespace declarations — handled at the command layer.

### Rename Command — Command-Layer Extensions

Three helpers in `src/commands/rename.ts` extend scanner coverage:

**`nodeIntroducesShadow()`** — detects parameter shadowing in: `FunctionDeclaration`, `FunctionExpression`, `ArrowFunction`, `MethodDeclaration`, `ConstructorDeclaration`, `GetAccessorDeclaration`, `SetAccessorDeclaration`.

**`bindingContainsName()`** — recursive binding check: `Identifier`, `ObjectBindingPattern`, `ArrayBindingPattern`, `OmittedExpression` (skipped).

**`isDeclaringIdentifier()`** — declaring contexts to skip:

| Parent node | Example |
|---|---|
| `Parameter` | `function foo(oldName)` |
| `VariableDeclaration` | `const oldName = …` |
| `BindingElement` | `const { oldName } = …` |
| `FunctionDeclaration.name` | `function oldName() {}` |
| `ClassDeclaration.name` | `class OldName {}` |

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

Verification spawns `tsc` as a subprocess and diffs error output (before vs after). `runTypeCheck(project)` is exported from `verify.ts` and reused by `move.ts`.

`collectUnresolvableDiagnostics(project)` returns `UnresolvableDiagnosticWithFile[]` for project-wide unresolvable import reporting. Exposed as `VerificationResult.unresolvableDiagnostics` after a verify pass.

DON'T: Duplicate `runTypeCheck` logic in command files. Import from `verify.ts`.

DON'T: Duplicate unresolvable-import scanning across command files. Call `collectUnresolvableDiagnostics(project)` from `verify.ts`.

## Dirty Worktree Guard

All four mutating commands (`move`, `rename`, `alias`, `extract-common`) refuse to write files when the git working tree has uncommitted changes (staged, unstaged, or untracked). This prevents accidental data loss by ensuring refactoring happens on a clean commit boundary.

- **`--force`** overrides the guard and allows mutation on a dirty worktree.
- **`--dry-run`** bypasses the guard automatically (dry runs don't write files).
- Non-git directories are silently allowed (no guard applies).
- The guard is implemented in `src/core/git.ts` (`ensureCleanWorktree()`) and called at the top of each mutating command before any file I/O.

DON'T: Add a new mutating command without calling `ensureCleanWorktree()` before writes.

## Conflict Detection

All four mutating commands (`move`, `rename`, `alias`, `extract-common`) perform conflict detection before applying changes. The read-only commands (`find`, `discover`, `workspace`, `analyze`) have no write operations and need no conflict guards.

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

## Audit Command

The `audit` command (`src/commands/audit.ts`) analyzes module health metrics:

```bash
bun src/cli.ts audit <directory>                        # Scan project for health metrics
bun src/cli.ts audit . --json                           # JSON output for tooling
bun src/cli.ts audit . --workspace                      # Scan across workspace packages
bun src/cli.ts audit src --fan-out-threshold=8           # Custom thresholds
```

### Metrics

- **Fan-out**: Number of distinct modules a file imports. High fan-out suggests a file orchestrates too many concerns (SRP violation).
- **Fan-in**: Number of distinct files importing a module. High fan-in on a non-utility file suggests a potential God module.
- **Instability**: `fanOut / (fanIn + fanOut)` — Robert C. Martin's metric. 0 = maximally stable, 1 = maximally unstable.
- **Export surface**: Number of exports per file. Large export surfaces suggest the module may be doing too much (ISP violation).
- **Circular dependencies**: DFS-based cycle detection over the import graph. Cycles indicate missing abstractions or inverted dependencies (DIP violation).

### Core Functions

- `computeMetrics(graph)` — Computes fan-out, fan-in, instability, and export count for every file in the `DependencyGraph`.
- `detectCycles(graph)` — Iterative DFS cycle detection with deduplication. Returns minimal cycles.
- `buildAuditReport(graph, options)` — Combines metrics and cycle detection, filters by configurable thresholds.

The command is read-only and composes existing `DependencyGraph` infrastructure from `src/core/graph.ts`.

## Unused Exports Command

The `unused` command (`src/commands/unused.ts`) finds exports never imported by other files. Uses `resolveTsConfig()` → `buildDependencyGraph()` → `scanExports()` pipeline, comparing each export against an imported-bindings map.

```bash
bun src/cli.ts unused src                        # Scan for unused exports
bun src/cli.ts unused src --json --ignore="*.test.ts"  # JSON, exclude tests
```

`ImportBinding.name` stores the original export name, so aliases (`import { foo as bar }`) are handled transparently. Whole-module imports (`import *`, `export *`, `import()`, `require()`) mark all exports as used.

DON'T: Add a new import type to the scanner without updating `buildImportedBindingsMap()` in `unused.ts`.

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

For cross-package moves, `updateBarrelExports()` **removes** source barrel re-exports entirely. `updateFileReferences()` also removes `export-all`/`export-from`/`export-all-as` references for cross-package moves.

DON'T: Change `export * from "./moved-file"` to `export * from "@scope/package"` — causes TS2308 duplicate export errors.

### Import Splitting for Mixed Barrel Imports

When only some bindings in an import come from the moved file, `updateFileReferences()` splits the import: moved bindings get the new package specifier, remaining bindings keep the original.

DON'T: Update entire import specifiers when only some bindings moved — causes TS2305 errors.

### Move Command File Handling

Use a `fileMoved` flag to ensure the file copy always happens regardless of code path (imports needing update, imports unchanged, no imports, parse failure).

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

- `TSC_ERROR_PATTERN` - `": error TS"` string for detecting TypeScript errors
- `EXPORT_STATEMENT_PATTERN` - Regex for export statements in barrel files
- `removeExtension()` - Strips `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs` extensions
- `TS_JS_EXTENSIONS` - Full extension regex including modern variants (`.mts/.cts/.mjs/.cjs`)
- `TS_JS_EXTENSION_PATTERN` - Legacy regex `/\.[tj]sx?$/` — misses modern variants

DON'T: Use inline regex or string literals. Import from `constants.ts`.

DON'T: Use `TS_JS_EXTENSION_PATTERN` in new code. Use `TS_JS_EXTENSIONS` or `removeExtension()`.

## Biome Configuration

### Excluding Directories

To exclude a directory from Biome scanning (e.g., `.swiz/`, `dist/`), use `files.includes` with a double-bang force-exclude pattern in `biome.json`:

```json
{
  "files": {
    "includes": ["!!**/.swiz"]
  }
}
```

DON'T: Use `files.ignore` — it doesn't exist in Biome and causes a parse error.
DON'T: Use `files.experimentalScannerIgnores` — it's deprecated; Biome will warn and suggest `files.includes` instead.
DON'T: Use `files.includes: ["**", "!!**/.swiz"]` — Biome's formatter removes `"**"` since the base includes are inherited from `extends`. Just the `!!` entry is sufficient.

### Linter Behavior

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

## npm Publish — pnpm v10 and .npmignore

When `package.json` has a `files` field, pnpm v10 includes those paths as a whitelist and does **not** apply `.npmignore` exclusions within them during `pnpm publish` or `pnpm pack --dry-run`. Test files and other patterns in `.npmignore` will still appear in the tarball listing.

This is cosmetic (source test files contain no secrets), but if exclusion is required, remove test patterns from the `files` whitelist at the `package.json` level instead of relying on `.npmignore`.

DON'T: Expect `.npmignore` glob patterns like `**/*.test.ts` to filter files that are explicitly whitelisted via the `files` field when using pnpm v10.

## Async Function Guidelines

Command handlers in `src/commands/` should only be `async` if they contain `await` expressions. The `analyzeCommand()` and `discoverCommand()` functions are synchronous—no `async` keyword needed.

DON'T: Mark functions as `async` without using `await`. This creates misleading API contracts and unnecessary Promise wrapping.

## CI Gate Authority

The hard-success-gate block after every push is the sole authority for declaring CI success. Run it unmodified every time — do not shortcut it.

DO: Run the full gate block after every push and wait for the final `✅ ALL CHECKS PASSED — push complete` line before asserting success.
DO: Let `gh run watch` run to completion so every job shows `✓` and the run shows `completed`/`success`.
DON'T: Declare "CI passed" based on partial `gh run watch` output while jobs are still in-progress.
DON'T: Omit the gate block or replace it with a shorter check. The gate exists to prevent premature declarations.

## Code Audit Completeness

When fixing a bug at one call site, audit all code paths that share the same pattern before declaring the fix complete.

DO: Grep for the same anti-pattern at adjacent call sites (e.g., barrel removals in `updateBarrelExports` → check import splits in `updateFileReferences`).
DO: Fix all sites in the same pass to avoid incremental discovery and fragmented commits.
DON'T: Implement only what the issue text describes — read surrounding code for the same bug at other sites.
DON'T: Ship a fix with a follow-up comment like "this only covers case X" when case Y at the same layer is known to share the same pattern.

## Scope Planning

Plan the full scope of a fix before writing code. Map all edge cases into the task list upfront.

DO: Use TaskCreate to list every edge case (additions, removals, mixed scenarios) before the first Edit.
DO: Commit all related changes together as one scope rather than fragmenting across multiple commits.
DO: When adding a CLI-wide feature (e.g., `--workspace` flag), scan all command files in `src/commands/*.ts` upfront and plan one commit covering every applicable command. Adding to `similar.ts` alone, then `find.ts`, then `analyze.ts`, then `move.ts`/`rename.ts` in separate commits is 4x the work and 4 fragmented commits.
DON'T: Ship three commits for what is logically one fix. If offset-correction, documentation, and comments all address the same concern, plan them as one scope.
DON'T: Declare a fix "done" without checking whether the same pattern applies to neighbouring code paths.

## Performance Patterns

### `withSourceFile` — Always Use the Program Overload When a Program Is Available

`withSourceFile` has two overloads:

```typescript
// File-path overload — reads from disk + creates a new ts.SourceFile every call
withSourceFile(filePath: string, callback, fallback)

// Program overload — retrieves already-parsed source file from memory, zero I/O
withSourceFile(program: ts.Program, filePath: string, callback, fallback)
```

**DON'T** use the file-path overload inside loops when a `ts.Program` is available in scope. Every call to `withSourceFile(filePath, ...)` invokes `ts.sys.readFile()` + `ts.createSourceFile()` — a full disk read and parse pass. The known violation is `audit.ts:81`:

```typescript
// WRONG — re-reads and re-parses every project file from disk
const exportCount = withSourceFile(file, scanExports, []).length;

// CORRECT — zero I/O, uses already-parsed source file from graph Program
const exportCount = withSourceFile(graph.program, file, scanExports, []).length;
```

### `buildDependencyGraph` Does Not Expose Its Internal `ts.Program`

`buildDependencyGraph` builds a `ts.Program` internally but only returns `DependencyGraph`. Commands needing source file access (`move.ts`, `rename.ts`) call `createProgram()` a second time. If ever fixed, add a `program: ts.Program` field to `DependencyGraph`.

DON'T: Add a third `createProgram` call to `move.ts` or `rename.ts` for any reason — the existing dual build is already a known inefficiency.

### `discoverWorkspace` Has No Cache

`discoverProject` (tsconfig-discovery.ts) has `discoveryCache`. `buildDependencyGraph` (graph.ts) has `graphCache`. `discoverWorkspace` (workspace.ts) has **no cache**.

Every call to `discoverWorkspace` traverses the directory tree, globs all `package.json` files, and reads each one. For a 20-package monorepo this is 20+ file reads per call. It is called at 9 sites across commands.

DON'T: Call `discoverWorkspace` in a loop or in a hot path. Call it once per command invocation and pass the result downstream.
DO: When adding a per-invocation workspace cache, mirror the `graphCache` Map pattern in `graph.ts` — key by absolute directory, store `WorkspaceInfo | null`.

### Parallelize Independent File Writes With `mapConcurrent`

Sequential `for...of` loops with `await writeFile(...)` per file serializes all writes. Each file write in `move`, `rename`, and `alias` is independent — no file's content depends on another's write result.

```typescript
// WRONG — sequential writes
for (const [filePath, content] of updates) {
    await rt.fs.writeFile(filePath, content);
}

// CORRECT — parallel writes with bounded concurrency
await mapConcurrent(
    [...updates],
    ([filePath, content]) => rt.fs.writeFile(filePath, content),
    { concurrency: 4 }
);
```

Use `mapConcurrent` (default concurrency=4) from `src/core/concurrency.ts` rather than bare `Promise.all` to avoid exhausting file descriptors on large graphs.
