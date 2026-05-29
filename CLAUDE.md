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

Case-insensitive dual search (filenames + exports) via `discoverProject()` + `scanExports()`. Exact matches sort first. `--type file|export|all` filters results. Files that fail to parse are silently skipped.

## Alias Command

`alias` (`src/commands/alias.ts`) normalizes import specifiers:

- **Strategies**: `--prefer=alias`, `--prefer=relative`, `--prefer=shortest`
- **Exact rewrites**: repeat `--rename-specifier="<from>=<to>"` for static specifier batches without strategy selection
- **Scope**: single files or directories; skips node_modules and imports outside `project.rootDir`
- **Coverage**: relative (`./foo`) and alias (`@/foo`) imports; specifiers need not start with `.`
- **Safety**: default `tsc --noEmit` before/after verification
- **Edits**: scanner/updater positions plus `applyTextChanges()`; never TypeScript-printer reserialize
- **Resolver**: use `calculateRelativeSpecifier()` and `findAliasForPath()` from `src/core/resolver.ts`

Case-only alias rename flow:

1. `move src/utils/Foo.ts src/utils/foo.ts` updates relative importers.
2. `alias src --rename-specifier="@utils/Foo=@utils/foo"` updates alias importers.

DON'T: Apply alias to complex dynamic imports or computed module paths; rely on verification and manual review.

## Type Checking Verification

- **Before/after comparison**: Runs `tsc --noEmit -p <tsconfig>` before and after changes
- **Error diffing**: Identifies new issues introduced by changes
- **Exit on failure**: Commands exit non-zero for new type errors
- **Bonus tracking**: Reports errors fixed by refactoring
- **Enabled by default**: `--no-verify` skips it

Verification spawns `tsc` and diffs output. `runTypeCheck(project)` is exported from `verify.ts` and reused by `move.ts`.

`collectUnresolvableDiagnostics(project)` returns `UnresolvableDiagnosticWithFile[]` for project-wide unresolvable import reporting. Exposed as `VerificationResult.unresolvableDiagnostics` after a verify pass.

DON'T: Duplicate `runTypeCheck` logic in command files. Import from `verify.ts`.

DON'T: Duplicate unresolvable-import scanning across command files. Call `collectUnresolvableDiagnostics(project)` from `verify.ts`.

## Case-Insensitive Filesystems

- `safeCaseRename()` performs two-step `git mv` for case-only file renames on macOS/APFS; use it before write/delete move logic.

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

Before `--rename-specifier`, `renameImportSpecifiers()` checks:
- **Duplicate target specifier**: Reports a second target-specifier import in the same file, exits non-zero, and leaves files unchanged.

### `hasLocalBinding()` Helper

Both `move.ts` and `rename.ts` implement `hasLocalBinding()` — an AST walker that checks if a file already declares a given name via variable/function/class/type/interface/enum declarations or import bindings (excluding the import being changed). When adding new mutating commands, include equivalent conflict detection.

DON'T: Add a new mutating command without conflict detection. All commands that write files must check for export name and binding conflicts before applying changes.

## Audit Command

`src/commands/audit.ts` analyzes module health metrics:

```bash
bun src/cli.ts audit <directory>
bun src/cli.ts audit . --json --workspace
bun src/cli.ts audit src --fan-out-threshold=8
```

## Tidy Command

`bun src/cli.ts tidy src --experimental [--json]` runs the orchestrator in `src/commands/tidy.ts`: `unused` + `similar` + `audit`, schema `1-experimental`. `--fix` applies mutations behind a dirty-worktree guard, `--max-changes` ceiling, one closing `tsc --noEmit` gate, and `git restore` rollback on new errors or `verificationIncomplete`. Safe-by-default: `dead-exports`; `alias-normalisation` needs `--alias-prefer=<alias|relative|shortest>`. Aggressive categories are opt-in (`--fix=<cat>`, not in `SAFE_TIDY_FIX_CATEGORIES`): `mock-cleanup` wired; `file-moves`/`case-renames`/`layout-relocations` no-op (#90). Each reuses its command's compute seam (`normalizeImports`, `computeMockCleanupChanges`) via `plan*Changes`; `mutationKindForCategory` sets `mutationKind`. MCP defaults `dryRun:true`.

### Metrics

- **Fan-out**: distinct modules imported; high = too many concerns.
- **Fan-in**: distinct importers; high non-utility fan-in = God module.
- **Instability**: `fanOut / (fanIn + fanOut)`. 0 = stable, 1 = unstable.
- **Export surface**: exports per file; high = too much module scope.
- **Circular dependencies**: DFS cycles over the import graph.

### Core Functions

- `computeMetrics(graph)` — fan-out, fan-in, instability, export count per file.
- `detectCycles(graph)` — iterative DFS cycle detection, deduped, minimal cycles.
- `buildAuditReport(graph, options)` — combines metrics + cycles, filters by thresholds.

Read-only; composes `DependencyGraph` from `src/core/graph.ts`.

## Unused Exports Command

The `unused` command (`src/commands/unused.ts`) finds exports never imported by other files. Uses `resolveTsConfig()` → `buildDependencyGraph()` → `scanExports()` pipeline, comparing each export against an imported-bindings map.

```bash
bun src/cli.ts unused src                        # Scan for unused exports
bun src/cli.ts unused src --json --ignore="*.test.ts"  # JSON, exclude tests
```

`ImportBinding.name` stores the original export name, so aliases (`import { foo as bar }`) are handled transparently. Whole-module imports (`import *`, `export *`, `import()`, `require()`) mark all exports as used.

### De-export vs delete (issue #58)

A hit means "no OTHER file imports this" — a **de-export** signal, NOT a **delete** signal. `countInternalReferences(sourceFile, exp)` counts same-file references (excluding the declaration and export statement); each `UnusedExport` carries `internalUsage` + `internalRefCount`. `internalUsage: false` → referenced nowhere, safe to delete; `true` → only the `export` keyword is redundant. Report exposes aggregate `deadCount`/`internalOnlyCount`; MCP `unused` surfaces all of these.

`countInternalReferences` resolves references by **symbol identity** with a checker (#92, so a shadowing local isn't counted); else name-based, biased "used". DON'T read `node.parent` while walking — unbound source files leave it undefined; track parent explicitly.

### Cross-tsconfig usage scope (issue #59)

Usage is counted across EVERY non-solution tsconfig discovered, not just the one `resolveTsConfig` picks. `buildProjectGraphs(tsconfigPath)` calls `discoverProject(dir)`, builds a graph per config (each cached by `buildDependencyGraph`), and `mergeImportedBindings()` unions their imported-bindings maps (keys normalized via `normalizePath`). Without this, an export consumed only by a sibling config (`scripts/` on `tsconfig.scripts.json`) is falsely reported dead. Report exposes `scannedConfigs`/`scannedFileCount`.

The `ignore` glob suppresses reported CANDIDATES only — ignored files still feed the usage graph (`importedBindings` is built from the full graph), so a test-only export is not reported dead.

DON'T: Add a new import type to the scanner without updating `buildImportedBindingsMap()` in `unused.ts`.
DON'T: Read `node.parent` when walking a program source file in `unused.ts` — pass the parent down through `ts.forEachChild` instead.
DON'T: Build the `unused` usage graph from one tsconfig — use `buildProjectGraphs()`.

## Barrel Command

`barrel` (`src/commands/barrel.ts`, read-only) analyzes barrels via `buildProjectGraphs()` + `mergeDependencyGraphs()`. `analyzeBarrels()` is the shared CLI/MCP seam; `buildBarrelReport(scans, context)` is pure (context injects `consumersOf`/`subpathExportOf`). Findings: sub-path export shadowing (#93), wildcard re-exports, barrel chains, unused barrels.

DON'T: Re-implement sub-path-export matching; call `findSubpathExportForFile()` (`resolver.ts`), which shares `resolvePackageSubpath()`/`findExplicitSubpathExport()` with `move`.

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

```bash
bun src/cli.ts move apps/web/src/utils/foo.ts packages/shared/src/foo.ts --dry-run
```

### Barrel Export Insertion

`addExportToDestinationBarrel()` inserts `export * from "./relative-path"` after the last existing export; skips if already present.

### Import Path Resolution

`findCrossPackageImport()` resolves the import path in priority order:
1. Dedicated non-wildcard `exports` entry for the file (e.g. `"./cn"`) → `@scope/pkg/cn` (via `findExplicitSubpathExport()`); wins over the root barrel (#93).
2. File in `src/` added to an existing barrel → package name (`@scope/pkg`).
3. Wildcard `exports` (`"./*"`) → `@scope/pkg/<subpath>`.
4. Fallback: package name + relative subpath.

DON'T: Run the barrel short-circuit before the explicit-`exports` check — reintroduces #93.
DON'T: Use relative cross-package paths; prefer package imports.

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

**When adding a new import to a file, include its first usage site in the same Edit call.** Biome strips unused imports after each Edit, so an import added without a usage in the same Edit will be gone before the next Edit lands.

DON'T: Add an import in one Edit and its usage in a subsequent Edit. Biome will strip the import before the usage lands.

## npm Publish — pnpm v10 and .npmignore

pnpm v10 treats `package.json`'s `files` field as a whitelist; `.npmignore` exclusions inside that whitelist are **ignored** during `pnpm publish`/`pnpm pack`. Test files in `files` appear in the tarball.

DON'T: Expect `.npmignore` patterns like `**/*.test.ts` to filter files explicitly listed in `files` under pnpm v10. Remove them from `files` instead.

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

### `graphCache` / `discoveryCache` Invalidation — Hot Path (issues #78, #87, #88)

`graphCache` (graph.ts) and `discoveryCache` (tsconfig-discovery.ts) both invalidate on content change via the shared mtime helpers in `path-utils.ts`: `snapshotMtimes(paths)` records mtimes at build time and `mtimesUnchanged(snapshot)` re-probes with cheap sync `statSync().mtimeMs` (catches in-place edits + deletions, NOT additions). `graphCache` keys by file set (`isCacheValid` — count + membership, #78) + per-file content mtime (#87); `discoveryCache` keys by discovered-tsconfig mtime (#88 — catches tsconfig edits/removals; additions caught by a throttled ~2s re-glob). Matters for the long-lived MCP server, where files/tsconfigs change between tool calls. Cache invalidation is a **hot-path** change: `buildProjectGraphs` builds and re-checks one graph per non-solution tsconfig, and `unused` exercises that across many sibling configs.

DO: Keep the validity probe the shared cheap sync `mtimesUnchanged` (`statSync().mtimeMs`) so unchanged files never force a rebuild. When changing invalidation, write the regression test FIRST (extend `graph.test.ts` / `tsconfig-discovery.test.ts`) and re-measure `unused`/`audit` against the 20s `bun test` timeout.
DON'T: Use async `Bun.file().lastModified` or a content hash in the validity check — both make `unused`/`audit` blow past the 20s timeout with full rebuilds every call.

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

## Commit Flow & Sandbox Constraints (this repo's hook environment)

Commits here are hook-gated in a fixed order. Run the preflight BEFORE the first `git commit`, not reactively after a block:

DO: Invoke the `/commit` skill, then call `TaskList` (sync must be recent), then `git commit`. Both are enforced by hooks; skipping either blocks the commit.
DON'T: Re-issue an identical `git commit -m "..."` after a block — a retry-guard fires on the repeated command even when each block had a different cause. After the second block, switch form: write the message to a file and `git commit -F <file>`.
DON'T: Write scratch files (commit messages, query files) to `~/.claude/...` — hidden home-dir paths are write-blocked in this sandbox, including the job tmp dir. Use `/tmp` or a repo-local path instead.
DON'T: `rm`/`rm -f` scratch files — the delete-safety hook blocks it. Leave `/tmp` files (OS-cleaned) or use `trash <path>`.

This repo is solo trunk-based (single author, trunk-mode enabled). DO commit refactors/fixes directly to `main`; the generic "branch first on default branch" rule does not apply here — follow the project's trunk signal.
