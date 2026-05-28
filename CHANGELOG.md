# Changelog

All notable user-facing changes to this project are documented here.

## [Unreleased]

### New Features

- **Experimental `tidy` command**: `resect tidy --experimental <dir>`
  composes the existing `unused`, `similar`, and `audit` analyses into one
  read-only grouped report. JSON output uses schema version
  `1-experimental`, which may change during the 1.x experimental window.
  The command is also exposed as a read-only MCP tool.

## [1.7.0] — 2026-05-28

### New Features

- **`resect-mcp` stdio MCP server**: New binary alongside the `resect`
  CLI exposing analysis (`find`, `analyze`, `audit`, `discover`,
  `workspace`, `unused`, `similar`) as Model Context Protocol tools.
  Point Claude Code or any MCP client at `resect-mcp` and the agent
  explores your codebase structure without copy-pasting CLI output.
  Setup instructions for Claude Code and Codex CLI are in the README.
- **Mutating MCP tools (`move`, `rename`, `alias`)**: The same three
  refactors the CLI ships now run over MCP. Each defaults to
  `dryRun: true`, returns a structured diff, refuses to mutate a
  dirty worktree unless `force: true`, and — when `dryRun: false` and
  `verify: true` — runs `tsc --noEmit` before AND after the change
  and returns the diagnostic delta (`errorsBefore`, `errorsAfter`,
  `newErrors`, `fixedCount`) so callers see exactly which type
  errors the refactor introduced or fixed. `extract-common` is still
  CLI-only pending a structured-result rewrite (#60).
- **`unused` distinguishes de-export from delete**: Each unused
  export now carries `internalUsage` and `internalRefCount`.
  `internalUsage: false` means referenced nowhere — safe to delete.
  `internalUsage: true` means only the `export` keyword is
  redundant — deleting the symbol would break its own module. The
  report adds aggregate `deadCount` and `internalOnlyCount` (#58).
- **`unused` counts usage across sibling tsconfigs**: Usage is
  computed from every non-solution tsconfig discovered in the
  project, not just the one resolved for the scanned directory. An
  export consumed only by a sibling config (e.g. `scripts/` on
  `tsconfig.scripts.json`) is no longer falsely reported dead.
  Report exposes `scannedConfigs` and `scannedFileCount` (#59).
- **`analyze` shows unused exports** in its output alongside
  imports, exports, and reverse-dependencies.

### Performance

- **`audit` skips per-file disk reads**: `computeMetrics` now looks
  up source files in `graph.program` (and any additional programs
  collected during a workspace merge) instead of re-reading and
  re-parsing each file from disk. `DependencyGraph` gains an
  optional `programs?: ts.Program[]` slot for workspace coverage,
  and `withGraphSourceFile(graph, file, …)` is exported as the
  canonical lookup (#61).
- **`move` and `rename` reuse the graph's program**: Each command
  previously built a second `ts.Program` via `createProgram(project)`
  after `buildDependencyGraph` had already built one — two parse
  passes per refactor. They now reuse `graph.program` with a
  `createProgram` fallback for test-constructed graphs (#63).
- **`discoverWorkspace` cache exposes `clearWorkspaceCache`** for
  tests that mutate the filesystem between calls (#62).

### Tooling

- **Pre-commit hook rebuilds binaries and re-links globally** when
  source changes, so local `resect` and `resect-mcp` invocations
  always reflect the latest commit.

## [1.6.0] — 2026-03-29

### New Features

- **`unused` command**: Scan a project for exports that are never imported
  by any other file. Supports `--json` output, `--ignore` glob patterns
  to exclude files (e.g. `*.test.ts`), and `--verbose` mode. Correctly
  handles aliased imports, namespace imports, dynamic imports, re-exports,
  and type-only imports.
- **`unused` gitignore filtering**: Files matched by `.gitignore` are now
  excluded by default, reducing noise from generated/vendored files.

### Test Coverage

- Added CLI integration tests for `workspace`, `similar`, `discover`,
  `analyze`, `find`, and `unused` commands using shared test helpers.
- Added 17 new similarity module unit tests covering `scoreToBucket`
  boundaries, `isWrapperBody` detection, directive variants, size/token
  ratio guards, and small interface member penalties.

### Bug Fixes

- **`move` no longer adds spurious barrel re-exports for same-package
  moves**: When moving a file within the same package in a workspace
  project, the destination barrel (`index.ts`) was incorrectly receiving
  a new `export *` line even though the source was never re-exported
  from it. This changed the package's public API surface unintentionally.
- **`git.ts` floating promises**: `proc.stdin.write()` and
  `proc.stdin.end()` are now properly awaited in `filterGitIgnoredFiles()`.

- **`move` and `alias` now preserve import extension style**: Generated
  specifiers match the original extension style. If the original import
  used `.ts` extensions (e.g. `'./vanilla.ts'`), the updated specifier
  keeps the extension. Extensionless imports stay extensionless. This
  prevents `alias --prefer=shortest` from stripping `.ts` extensions in
  codebases that use `allowImportingTsExtensions`.

- **`extract-common` no longer merges same-file intentional aliases**:
  Structurally identical declarations with different names in the same
  file (e.g. `type FlushCallbacks` and `type RecomputeInvalidatedAtoms`
  both defined as `(store: Store) => void`) are now treated as
  intentional aliases and left untouched. Previously they were merged,
  breaking export statements that referenced the removed alias.

- **File paths in command output are now relative to the project root**:
  `analyze`, `move`, and `rename` output previously used `process.cwd()`
  as the base for relative paths, producing long `../../../../` chains
  when analyzing projects outside the working directory. Paths are now
  relative to the tsconfig project root.

- **Barrel insertion now preserves quote style and extension conventions**:
  When `move` adds `export *` to a destination barrel, it now matches
  the existing file's quote style (single vs double) and extension
  usage (`.ts` vs extensionless).

- **`extract-common` skips value extractions that would create circular
  imports**: When extracting a duplicate function would introduce a
  runtime circular dependency (the canonical file already imports from
  the duplicate's file), the extraction is skipped with a warning.
  Type-only extractions are unaffected since `import type` is erased
  at compile time.

## [1.5.0] - 2026-03-28

### New Features

- **Full library API**: All CLI capabilities are now importable as a
  programmatic library via `import { ... } from "@mherod/resect"`.
  Every command, core utility, and type is exported from the package
  entry point. Programmatic functions like `analyze()`, `search()`,
  `analyzeSimilarity()`, `moveModule()`, `renameSymbol()`,
  `buildAuditReport()`, `computeMetrics()`, and `detectCycles()`
  return structured data without side effects, making resect
  embeddable in other tools and scripts.

## [1.3.1] - 2026-03-14

### Bug Fixes

- **`similar` produces fewer false positives**: Functions that share a
  similar structure but use different constants or string literals (e.g.
  `KEBAB_CASE_REGEX` vs `HOOK_NAMING_REGEX`) are no longer incorrectly
  reported as duplicates. True duplicates remain at full score. (#22)

### Improvements

- **`--workspace` flag now shown in `--help`**: The flag was already
  functional across all commands but was missing from their help text.
  Running `--help` on `move`, `rename`, `analyze`, `find`, `alias`, and
  `discover` now documents the option.

## [1.3.0] - 2026-03-14

### New Features

- **New `extract-common` command**: Automatically consolidates duplicate
  functions by keeping one canonical copy and replacing all other
  occurrences with imports pointing to that copy. Supports `--dry-run`,
  `--group` (target a specific group by index), and `--threshold`. The
  `similar` command now suggests ready-to-run `extract-common` follow-up
  commands for each group it finds. (#17)

- **`extract-common --output`**: Write the extracted function to a
  caller-specified destination file rather than keeping it in place.
  All source locations are rewritten to import from that file.

- **`similar --strict`**: Exit with a non-zero error code when similar
  functions are detected, making `similar` usable as a CI or pre-commit
  gate.

- **`similar --skip-directives`**: Exclude functions that contain
  `"use server"`, `"use client"`, `"use cache"`, or `"use strict"`
  directives from similarity analysis. These functions cannot be safely
  consolidated. (#20)

- **`similar --min-lines`**: Exclude functions whose body is shorter
  than a given line count. Thin one-liner wrappers are typically not
  worth consolidating and can now be filtered out. (#21)

- **`similar --skip-same-file`**: Skip groups where all matching
  functions live in the same file, reducing noise from co-located
  patterns that are unlikely extraction candidates.

- **`similar --only-related-to`**: Restrict results to groups that
  contain at least one function from a specified file, folder, or glob
  pattern. Also available in the `extract-common` command. (#19)

- **`--only-related-to` for `find`, `analyze`, `discover`**: The
  path-scoping filter previously added to `similar` is now available
  in `find` (limits searched files), `analyze` (filters `referencedBy`
  results), and `discover` (filters file ownership output).

- **`similar --name-threshold` and `--same-name-only`**: Filter
  similarity groups by function name similarity, using camelCase token
  comparison. `--same-name-only` restricts groups to identically-named
  functions only. Reduces noise from structurally similar but
  semantically unrelated functions. (#18)

### Bug Fixes

- **`similar` detects fewer false positives**: Similarity scoring now
  uses bigram Jaccard similarity and applies body-length and token-count
  ratio pre-filters, eliminating spurious matches produced when
  normalisation collapses different bodies to the same form.

## [1.2.0] - 2026-03-14

### New Features

- **Node.js library API**: resect can now be used programmatically from
  Node.js projects in addition to the CLI. A public `src/index.ts` entry
  point exports the core commands and types, and `package.json` includes
  an `exports` map for both Bun and Node.js consumers.

- **Unresolvable import diagnostics in `analyze`**: The `analyze` command
  now reports every import in the project that cannot be resolved, showing
  the file path, line number, and failing specifier. Previously this
  information was only available as a count in verification output.

- **Rename handles more export patterns**: The `rename` command now
  correctly renames default exports, arrow function exports, and namespace
  re-exports (`export * as name from`). Previously these patterns were
  silently skipped.

- **Conflict detection before applying changes**: All three mutating
  commands now check for conflicts up front and abort with a clear error
  instead of producing broken output:
  - `rename`: reports if the new name already exists as an export in the
    source file, or as a local binding in any importer. (#1)
  - `move`: reports if any of the moved file's exports already exist in
    the destination barrel, or clash with local bindings in importers.
  - `alias`: reports if normalising an import would produce a duplicate
    specifier with overlapping bindings in the same file.

### Bug Fixes

- **`alias` now normalises alias imports**: A guard that prevented
  converting alias imports (e.g. `@/foo`) to relative paths (and vice
  versa) has been removed. The command now normalises all in-project
  imports regardless of their current form. (#2)

- **`alias` extension coverage**: Imports referencing `.mts`, `.cts`,
  `.mjs`, and `.cjs` files were not being matched correctly. Extension
  stripping and alias lookup now cover all TypeScript and JavaScript
  extension variants.

- **`rename` no longer modifies shadowed locals**: When a local variable
  inside a function has the same name as the symbol being renamed, the
  rename command previously updated those shadowed references incorrectly.
  Scope-aware traversal now skips any reference that is shadowed by a
  local declaration. (#1)

- **`move` no longer rewrites barrel-consumer imports for same-package
  moves**: When moving a file within the same package, files that import
  through a barrel (e.g. `import { Foo } from "./index"`) had their import
  specifiers incorrectly rewritten to direct paths. The barrel's re-export
  is now updated in place, leaving consumers unchanged.

### Improvements

- **`alias` is significantly faster on large projects**: The command now
  builds a single shared TypeScript programme for all files instead of one
  per file. Projects with many source files will see substantially reduced
  run times. (#3)

## [1.1.0] - 2026-03-13

Initial public release.
