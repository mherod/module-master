# resect

**The surgical refactoring tool for TypeScript monorepos.** Move files between packages, rename exports, and watch every import update automatically — with zero breaking changes.

Built on the TypeScript Compiler API for AST-level precision. Understands your barrel files, respects your path aliases, detects unresolvable imports, and handles the gnarly edge cases that break other tools.

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
npm install -g @mherod/resect

# Or with pnpm
pnpm add -g @mherod/resect

# Or with bun
bun add -g @mherod/resect
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
resect analyze src/core/resolver.ts -p .
```

Shows:
- All exports from the file (name, type, line number)
- All imports used by the file (specifier, bindings, resolved path with `--verbose`)
- All files that reference this module
- Barrel files that re-export this module
- **Unresolvable imports** — specifiers that cannot be resolved, with line numbers and diagnostics
- **Project-wide unresolvable imports** — all broken imports across the entire project, shown at the end

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
- Use `--type file|export|all` to narrow results

### `alias <target>`

Normalize import paths using tsconfig aliases, relative paths, or the shortest option.

```bash
resect alias src/components --prefer=alias    # Convert to tsconfig path aliases
resect alias src --prefer=relative            # Convert to relative paths
resect alias . --prefer=shortest              # Pick whichever is shorter
resect alias src --prefer=alias --dry-run     # Preview changes
```

- Processes both relative (`./foo`) and alias (`@/foo`) imports — normalizes in either direction
- Handles all TypeScript/JavaScript/Vue extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.vue`
- Detects and skips changes that would create duplicate bindings
- Verification enabled by default; use `--no-verify` to skip

### `discover <directory>`

Map all tsconfig.json files in a project.

```bash
resect discover /path/to/monorepo --verbose
```

Shows tsconfig inheritance, project references, file ownership, and path aliases.

### `workspace <directory>`

Discover monorepo workspace packages and their structure.

```bash
resect workspace /path/to/monorepo
resect workspace /path/to/monorepo --json
resect workspace /path/to/monorepo --verbose
```

Supports pnpm, yarn, and npm workspaces. Shows packages, entrypoints, barrel files, exports map, and internal dependencies.

### `similar <directory>`

Find similar or duplicate functions across your codebase for consolidation.

```bash
resect similar src                                    # Scan for duplicates
resect similar src --threshold=0.9                    # Higher similarity required
resect similar src --strict                           # Exit code 1 if found (for CI)
resect similar src --json                             # Machine-readable output
resect similar src --name-threshold=0.5               # Require similar names too
resect similar src --same-name-only                   # Only identical names
resect similar src --skip-same-file                   # Skip same-file groups
resect similar src --skip-directives                  # Skip functions with "use server" etc.
resect similar src --min-lines=3                      # Skip thin one-liners
resect similar src --only-related-to=src/utils/foo.ts # Scope to a file/folder
resect similar src --workspace                        # Scan across all packages
```

Uses bigram Jaccard similarity on normalized function bodies. Groups are classified as `exact`, `high`, or `medium` similarity. Supports camelCase token comparison for name filtering.

### `extract-common <directory>`

Consolidate duplicate functions found by `similar` into shared modules.

```bash
resect extract-common src --dry-run                         # Preview changes
resect extract-common src --group=1                         # Target specific group
resect extract-common src --output=src/shared/utils.ts      # Write to new file
resect extract-common src --threshold=1.0                   # Only exact duplicates
resect extract-common src --skip-same-file --skip-directives
```

Without `--output`, keeps one canonical copy in place and replaces all others with imports. With `--output`, writes the function to the specified destination file and rewrites all source locations to import from it.

### `unused <directory>`

Find exports that no other file in the project imports.

```bash
resect unused src                            # Scan for unused exports
resect unused src --json                     # JSON output for tooling
resect unused src --ignore="*.test.ts"       # Exclude test files
resect unused src --verbose                  # Detailed output
```

A hit is a **de-export** signal, not automatically a **delete** signal. Each result carries `internalUsage` / `internalRefCount`: when `internalUsage` is `false` the symbol is referenced nowhere and is safe to delete; when `true`, it is still called within its own file, so only the `export` keyword is redundant — deleting the symbol would break its own module. The report also returns aggregate `deadCount` and `internalOnlyCount`.

Correctly handles aliased imports, namespace imports, dynamic imports, re-exports, and type-only imports.

## MCP Server (Claude Code)

resect ships a stdio [Model Context Protocol](https://modelcontextprotocol.io) server, `resect-mcp`, that exposes its read-only analysis as MCP tools. Point Claude Code (or any MCP client) at it and let the agent explore your codebase structure directly — no copy-pasting CLI output.

**Tools exposed** (all read-only — `resect-mcp` never modifies files):

| Tool | Description |
|------|-------------|
| `find` | Find files and exports by name |
| `analyze` | A module's exports, imports, referencing files, barrel re-exports, unresolvable + unused exports |
| `discover` | tsconfig files, extends chains, project references, path aliases, file ownership |
| `workspace` | Monorepo packages, entrypoints, exports maps, barrel files |
| `audit` | Module health: fan-out, fan-in, instability, large export surfaces, cycles |
| `unused` | Exports no other file imports, flagged as de-export vs delete (`internalUsage`, `deadCount`, `internalOnlyCount`) |
| `similar` | Similar/duplicate functions, type aliases, and interfaces |

The mutating commands (`move`, `rename`, `alias`, `extract-common`) are intentionally **not** exposed over MCP — run those yourself from the CLI where you can review a `--dry-run` first.

### Setup

The `resect-mcp` binary is installed alongside the `resect` CLI, so a global install gives you both:

```bash
npm install -g @mherod/resect
```

Register it with Claude Code (user scope makes it available in all your projects):

```bash
claude mcp add -s user resect -- resect-mcp
```

Verify the connection:

```bash
claude mcp get resect
# resect:
#   Scope: User config (available in all your projects)
#   Status: ✓ Connected
```

Claude can now call the resect tools (`find`, `analyze`, `audit`, …) directly. To scope the server to a single repo instead, drop `-s user` (local scope) or commit a `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "resect": {
      "command": "resect-mcp"
    }
  }
}
```

To remove it: `claude mcp remove resect -s user`.

### Codex CLI

Register the same `resect-mcp` binary with [Codex](https://github.com/openai/codex) as a global stdio server:

```bash
codex mcp add resect -- resect-mcp
```

Verify it's registered:

```bash
codex mcp get resect
# resect
#   enabled: true
#   transport: stdio
#   command: resect-mcp
```

To remove it: `codex mcp remove resect`.

> **Tip:** every tool accepts an absolute `directory`/`project`/`file` path, so the server's working directory doesn't matter — point it at any project on disk.

## Features

- **AST-level precision** — Uses TypeScript Compiler API, not regex (see [AST Node Coverage](./CLAUDE.md#ast-node-coverage) for the full node-kind support matrix)
- **Type-safe refactoring** — Runs `tsc --noEmit` before and after changes
- **Full import coverage** — Named, default, namespace, dynamic, require, require.resolve
- **Test mock support** — jest.mock(), vi.mock(), vitest.mock()
- **Path alias preservation** — Respects your tsconfig paths
- **Barrel file intelligence** — Recursively resolves re-export chains to find deep dependencies
- **Monorepo-native** — First-class support for pnpm, yarn, and npm workspaces
- **Cross-package moves** — The hard problem, solved
- **Import splitting** — Handles mixed imports from barrels correctly
- **Auto-rebuild** — Keeps dist/ in sync after cross-package moves
- **Dry-run mode** — Preview everything before committing
- **Unresolvable import detection** — Surfaces broken imports with file, line, and specifier
- **Modern extension support** — Handles `.mts`, `.cts`, `.mjs`, `.cjs` in addition to classic extensions
- **Similarity detection** — Find duplicate/similar functions using bigram Jaccard on normalized ASTs
- **Automated extraction** — Consolidate duplicates by extracting to shared modules with import rewriting
- **Smart filtering** — Name similarity, body line count, directive detection, same-file exclusion, path scoping
- **MCP server** — Exposes read-only analysis (`find`, `analyze`, `audit`, `unused`, …) to AI agents over the Model Context Protocol

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
| `--json` | | Output in JSON format (workspace/similar) |
| `--threshold` | | Similarity threshold 0.0–1.0 (similar/extract-common) |
| `--strict` | | Exit with error if similar functions found (CI mode) |
| `--name-threshold` | | Name similarity threshold (similar/extract-common) |
| `--same-name-only` | | Only group functions with identical names |
| `--skip-same-file` | | Skip groups where all functions are in the same file |
| `--skip-directives` | | Skip functions with compile-time directives |
| `--min-lines` | | Minimum function body lines to include |
| `--only-related-to` | | Scope results to a file, folder, or glob pattern |
| `--max-groups` | | Maximum groups to display (similar) |
| `--group` | | Target a specific group number (extract-common) |
| `--output` | `-o` | Write extracted functions to this file (extract-common) |
| `--workspace` | | Scan across all workspace packages |

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
pnpm install         # Install dependencies
pnpm test            # Run tests
pnpm run lint        # Lint and format with Biome
pnpm run typecheck   # Type check with tsc
pnpm run build       # Compile to standalone binary
```

## License

PolyForm Noncommercial 1.0.0.

Commercial use, resale, or repurposing for commercial gain requires prior
written permission from Matthew Herod. Commercial licensing inquiries:
matthew.herod@gmail.com.
