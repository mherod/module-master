# module-master

Precise TypeScript/JavaScript module refactoring CLI. Move files, rename exports, and update all import references across your codebase.

## Install

```bash
bun install
```

## Usage

```bash
# Analyze a module's imports, exports, and references
bun src/cli.ts analyze src/utils/helpers.ts

# Move a file and update all imports
bun src/cli.ts move src/old/file.ts src/new/file.ts

# Rename an export and update all imports
bun src/cli.ts rename src/components/Button.tsx Button PrimaryButton

# Discover tsconfig structure in a project
bun src/cli.ts discover .

# Preview changes without modifying files
bun src/cli.ts move src/old.ts src/new.ts --dry-run
```

### Working with External Projects

Use `-p` to specify a project directory when analyzing files outside the current project:

```bash
bun src/cli.ts analyze /path/to/file.ts -p /path/to/project
bun src/cli.ts discover /path/to/monorepo --verbose
```

## Commands

### `analyze <file>`

Analyze a module's imports, exports, and references throughout the codebase.

```bash
bun src/cli.ts analyze src/components/Button.tsx --verbose
```

Output includes:
- All exports from the file
- All imports used by the file
- All files that reference this module
- Barrel files that re-export this module

### `move <source> <target>`

Move a file and update all import references across the codebase.

```bash
bun src/cli.ts move src/utils/old.ts src/helpers/new.ts --dry-run
```

Features:
- Updates all import statements referencing the moved file
- Preserves path aliases when possible
- Updates barrel file re-exports
- Handles dynamic imports and require() calls
- Updates internal imports within the moved file

### `rename <file> <oldName> <newName>`

Rename an exported symbol and update all imports.

```bash
bun src/cli.ts rename src/components/Button.tsx Button PrimaryButton --dry-run
```

Features:
- Renames the export in the source file
- Updates all named imports across the codebase
- Updates barrel file re-exports
- Preserves import aliases (`import { Old as X }` → `import { New as X }`)

### `discover <directory>`

Discover all tsconfig.json files in a project and understand its structure.

```bash
bun src/cli.ts discover /path/to/monorepo --verbose
```

Output includes:
- All tsconfig.json files found
- Include/exclude patterns for each config
- Project references (for solution-style configs)
- File ownership map (which config controls each file)
- Path aliases defined in each config

## Features

- **Precise AST-based refactoring** using TypeScript Compiler API
- **All import types supported**: named, default, namespace, dynamic, require, require.resolve
- **Test mock support**: jest.mock(), vi.mock(), vitest.mock()
- **Path alias preservation** from tsconfig.json
- **Barrel file updates** for re-exports
- **Smart tsconfig discovery** for monorepos and complex project structures
- **Solution-style config support** with project references
- **Dry-run mode** to preview changes before applying

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help message |
| `--version` | `-v` | Show version |
| `--dry-run` | `-n` | Preview changes without modifying files |
| `--project` | `-p` | Path to project directory or tsconfig.json |
| `--verbose` | | Enable detailed output |

## How It Works

1. **Load project** — Parse tsconfig.json, extract compiler options and path aliases
2. **Discover configs** — Find all tsconfig files, build file ownership map
3. **Build graph** — Scan all project files, create import/importedBy maps
4. **Find references** — Query graph for files importing target module
5. **Calculate changes** — Determine new import specifiers based on operation
6. **Apply updates** — Modify source text at precise AST node positions

## Development

```bash
bun test             # Run tests
bun run lint         # Lint and format with Biome
bun run typecheck    # Type check with tsc
bun run build        # Compile to standalone binary
```
