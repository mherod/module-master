# resect

**The surgical refactoring tool for TypeScript monorepos.** Move files between packages, rename exports, and watch every import update automatically — with zero breaking changes.

Built on the TypeScript Compiler API for AST-level precision. Understands your barrel files, respects your path aliases, and handles the gnarly edge cases that break other tools.

## Why resect?

Refactoring in monorepos is painful. Move a utility from your app to a shared package and you'll spend the next hour:
- Hunting down every import that needs updating
- Figuring out which barrel files need new exports
- Rebuilding packages in the right order
- Fixing the type errors you inevitably missed

**resect does all of this in one command:**

```bash
resect move apps/web/src/utils/formatDate.ts packages/shared/src/formatDate.ts
```

That's it. Every import updated. Barrel files handled. Packages rebuilt. Type-checked and verified.

## Install

```bash
# Global install (recommended)
bun add -g resect

# Or with npm
npm install -g resect
```

## Quick Start

```bash
# Move a file and update all imports
resect move src/old/file.ts src/new/file.ts

# Preview changes without modifying files
resect move src/old.ts src/new.ts --dry-run

# Move between packages in a monorepo
resect move apps/web/src/utils/helper.ts packages/shared/src/helper.ts
```

## Cross-Package Refactoring

The killer feature. Move files between packages in your monorepo and resect handles everything:

```bash
resect move apps/main-web/lib/utils/date-formatter.ts packages/shared-utils/src/date-formatter.ts --verbose
```

### What happens automatically:

1. **Workspace discovery** — Detects pnpm, yarn, or npm workspaces
2. **Smart import updates** — Changes imports to use package names (`@scope/shared`) instead of brittle relative paths
3. **Barrel file management** — Adds export to destination package's index.ts, removes from source
4. **Import splitting** — When a file imports multiple things from a barrel and only some are moving, splits the import correctly:

```typescript
// Before: importing from a barrel that re-exports the moved file
import { formatDate, makeAuthorUrl } from "@/lib/utils";

// After: automatically split into two imports
import { formatDate } from "@plugg/shared-utils";
import { makeAuthorUrl } from "@/lib/utils";
```

5. **Package rebuilds** — Runs build scripts on affected packages so dist/ stays in sync
6. **Type verification** — Runs `tsc --noEmit` before and after to catch any issues

### No more duplicate export errors

Other tools naively change `export * from "./moved-file"` to `export * from "@scope/package"`, which pulls in everything and causes conflicts. resect removes the re-export entirely — the destination package exports it now.

## Commands

### `move <source> <target>`

Move a file and update all import references across the codebase.

```bash
resect move src/utils/old.ts src/helpers/new.ts --dry-run
```

**Handles:**
- All import statements referencing the moved file
- Path aliases from tsconfig.json
- Barrel file re-exports (`export * from`)
- Dynamic imports and `require()` calls
- Internal imports within the moved file
- Jest/Vitest mock calls

### `rename <file> <oldName> <newName>`

Rename an exported symbol and update all imports.

```bash
resect rename src/components/Button.tsx Button PrimaryButton --dry-run
```

- Renames the export in the source file
- Updates all named imports across the codebase
- Updates barrel file re-exports
- Preserves import aliases (`import { Old as X }` → `import { New as X }`)

### `analyze <file>`

Understand a module's place in your codebase.

```bash
resect analyze src/components/Button.tsx --verbose
```

Shows:
- All exports from the file
- All imports used by the file
- All files that reference this module
- Barrel files that re-export this module

### `find <query>`

Search for files and exports by name.

```bash
resect find User -p /path/to/project
resect find Button --type export
resect find helpers --type file
```

- Case-insensitive partial matching
- Searches filenames and export names simultaneously
- Smart sorting: exact matches first

### `alias <target>`

Normalize import paths using tsconfig aliases, relative paths, or the shortest option.

```bash
resect alias src/components --prefer=alias
resect alias src --prefer=relative
resect alias . --prefer=shortest
```

### `discover <directory>`

Map all tsconfig.json files in a project.

```bash
resect discover /path/to/monorepo --verbose
```

Shows tsconfig inheritance, project references, file ownership, and path aliases.

### `workspace <directory>`

Discover monorepo workspace packages and their structure.

```bash
resect workspace /path/to/monorepo --json
```

Supports pnpm, yarn, and npm workspaces. Shows packages, entrypoints, barrel files, and internal dependencies.

## Features

- **AST-level precision** — Uses TypeScript Compiler API, not regex
- **Type-safe refactoring** — Runs `tsc --noEmit` before and after changes
- **Full import coverage** — Named, default, namespace, dynamic, require, require.resolve
- **Test mock support** — jest.mock(), vi.mock(), vitest.mock()
- **Path alias preservation** — Respects your tsconfig paths
- **Barrel file intelligence** — recursively resolves re-export chains to find deep dependencies
- **Monorepo-native** — First-class support for pnpm, yarn, and npm workspaces
- **Cross-package moves** — The hard problem, solved
- **Import splitting** — Handles mixed imports from barrels correctly
- **Auto-rebuild** — Keeps dist/ in sync after cross-package moves
- **Dry-run mode** — Preview everything before committing

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help message |
| `--version` | `-v` | Show version |
| `--dry-run` | `-n` | Preview changes without modifying files |
| `--project` | `-p` | Path to project directory or tsconfig.json |
| `--verbose` | | Enable detailed output |
| `--no-verify` | | Skip type checking verification (not recommended) |
| `--type` | `-t` | Filter find results by type: `file`, `export`, or `all` |
| `--prefer` | | Alias strategy: `alias`, `relative`, or `shortest` |
| `--json` | | Output in JSON format (workspace command) |

## How It Works

1. **Load project** — Parse tsconfig.json, extract compiler options and path aliases
2. **Discover workspace** — Find all packages, barrel files, and tsconfigs
3. **Build dependency graph** — Scan all files, create import/importedBy maps with recursive barrel resolution
4. **Find references** — Query graph for files importing target module (direct and through barrels)
5. **Calculate changes** — Determine new specifiers, split imports if needed, identify removals
6. **Apply updates** — Modify source text at precise AST node positions
7. **Update barrels** — Add exports to destination, remove from source
8. **Rebuild packages** — Run build scripts on affected packages
9. **Verify types** — Run tsc to ensure no breaking changes

## Development

```bash
bun test             # Run tests
bun run lint         # Lint and format with Biome
bun run typecheck    # Type check with tsc
bun run build        # Compile to standalone binary
```

## License

MIT
