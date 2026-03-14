# Changelog

All notable user-facing changes to this project are documented here.

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
