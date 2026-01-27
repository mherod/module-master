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
bun src/cli.ts analyze <file>                      # Analyze imports/exports/references
bun src/cli.ts move <source> <target> [--dry-run]  # Move file, update all imports
bun src/cli.ts rename <file> <old> <new> [--dry-run]  # Rename export, update all imports
```

## Architecture

The codebase uses the TypeScript Compiler API (`typescript` package) for parsing and analyzing TypeScript/JavaScript files. This enables precise handling of all import/export variants, path aliases, and barrel files.

### Core Modules (`src/core/`)

- **project.ts** - Loads tsconfig.json, extracts path aliases, creates TS programs
- **scanner.ts** - AST traversal to extract all imports/exports from a source file
- **resolver.ts** - Module path resolution, alias matching, relative path calculation
- **graph.ts** - Builds dependency graph (imports/importedBy maps) for the entire project
- **updater.ts** - Applies text changes to update import specifiers in files

### Data Flow

1. **Load project** → Parse tsconfig.json, extract compiler options and path aliases
2. **Build graph** → Scan all project files, create import/importedBy maps
3. **Find references** → Query graph for files importing target module
4. **Calculate changes** → Determine new import specifiers based on operation
5. **Apply updates** → Modify source text at precise AST node positions

### Key Types (`src/types.ts`)

- `ModuleReference` - Represents an import/export with source location, specifier, and bindings
- `ReferenceType` - Discriminates import variants (named, namespace, dynamic, require, etc.)
- `ProjectConfig` - tsconfig data including path aliases
- `DependencyGraph` - Maps files to their imports and reverse references

## Bun Runtime

This project uses Bun exclusively. Use `Bun.file()` for file I/O instead of node:fs.

## TypeScript Compiler API

When calling `node.getStart()` on AST nodes, always pass the sourceFile parameter: `node.getStart(sourceFile)`. Without it, the method fails with "undefined is not an object" in Bun's runtime. `node.getEnd()` does not accept parameters.

DON'T: `node.getStart()` — fails at runtime
DO: `node.getStart(sourceFile)` — works correctly
