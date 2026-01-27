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

# Preview changes without modifying files
bun src/cli.ts move src/old.ts src/new.ts --dry-run
```

## Features

- Precise AST-based refactoring using TypeScript Compiler API
- Handles all import types: named, default, namespace, dynamic, require
- Preserves path aliases from tsconfig.json
- Updates barrel file re-exports
- Dry-run mode to preview changes
