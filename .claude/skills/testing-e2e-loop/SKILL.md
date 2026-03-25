---
description: Clone a real-world TypeScript project, exercise every resect command against it, verify builds still pass, fix any bugs found, and loop until all commands produce correct output.
triggers:
  - test resect against a real project
  - e2e testing loop
  - try resect on a real codebase
  - test our tool on a popular project
  - integration testing with build verification
---

# E2E Testing Loop

Test resect's refactoring commands against a real-world TypeScript project. Clone, refactor, verify the build, fix bugs, repeat.

## Overview

This is a test-fix loop, not a one-shot task. Each command is applied to a real codebase, the resulting diff is inspected, the project is rebuilt, and any breakage is traced back to a resect bug and fixed immediately — before moving to the next command.

## Step 1: Clone a Target Project

Pick a popular TypeScript project with a moderate codebase, diverse import/export patterns, and a working build. Clone it to `/tmp/` so it's disposable.

Good candidates: zustand, jotai, zod, trpc, tRPC — libraries with clean TypeScript source, barrel files, and rollup/tsc builds.

```bash
git clone --depth 1 https://github.com/<org>/<repo>.git /tmp/<repo>
pnpm --dir /tmp/<repo> install
```

## Step 2: Establish a Baseline Build

Build the project before any changes to confirm it compiles clean. This is the control — if the baseline build fails, pick a different project.

```bash
pnpm --dir /tmp/<repo> run build
```

Record the build output. Any warnings in the baseline are acceptable and should not be treated as regressions after refactoring.

## Step 3: Discover and Audit

Run read-only commands to understand the project structure and identify refactoring targets:

```bash
bun src/cli.ts discover /tmp/<repo>
bun src/cli.ts audit /tmp/<repo>/src
bun src/cli.ts similar /tmp/<repo>/src --bucket=exact --format=compact
bun src/cli.ts similar /tmp/<repo>/src --bucket=high --format=compact
bun src/cli.ts find <query> -p /tmp/<repo>
bun src/cli.ts analyze /tmp/<repo>/src/<file>.ts -p /tmp/<repo>
```

Use the `similar` output to identify extraction targets. Use `analyze` to understand a module's imports/exports/consumers before moving or renaming it.

## Step 4: Test Each Command (The Loop)

For each refactoring command, follow this exact cycle:

### 4a. Apply the refactor

Run the command without `--dry-run`:

```bash
# rename
bun src/cli.ts rename /tmp/<repo>/src/<file>.ts <oldName> <newName> --force --no-verify

# move
bun src/cli.ts move /tmp/<repo>/src/<old-path>.ts /tmp/<repo>/src/<new-path>.ts --force --no-verify

# extract-common
bun src/cli.ts extract-common /tmp/<repo>/src --group=<N> --force

# alias
bun src/cli.ts alias /tmp/<repo>/src --prefer=shortest --force --no-verify -p /tmp/<repo>/tsconfig.json
```

Use `--force` to skip the dirty-worktree guard (the target repo is disposable). Use `--no-verify` to skip tsc verification (we'll verify with the project's own build).

### 4b. Inspect the diff

```bash
git -C /tmp/<repo> diff
```

Check every hunk:
- Are import specifiers updated correctly?
- Are local binding names preserved (not broken)?
- Are non-module strings (URLs, file paths, config values) left untouched?
- Are `import type` / `export type` used for type-only re-exports?
- Are barrel re-exports handled correctly (removed for cross-package, updated for same-package)?

### 4c. Rebuild

```bash
pnpm --dir /tmp/<repo> run build
```

If the build fails, the refactor broke something. Do NOT move on.

### 4d. Fix or file

If the diff is wrong or the build breaks:

1. Identify the root cause in resect's source code
2. Fix it immediately in the resect codebase
3. Run resect's own quality checks: `pnpm typecheck && pnpm lint && pnpm test`
4. Reset the target project: `git -C /tmp/<repo> checkout -- .`
5. Clean up any untracked files from moves: check `git -C /tmp/<repo> status` and remove them
6. Re-apply the refactor with the fix
7. Verify the diff and rebuild again
8. Commit the fix to resect

### 4e. Reset and continue

After a successful verification:

```bash
git -C /tmp/<repo> checkout -- .
# Also remove any untracked files created by move operations
git -C /tmp/<repo> clean -fd
```

Move to the next command.

## Step 5: Commands to Test (Priority Order)

Test in this order — earlier commands are more likely to have edge cases:

1. **rename** — Renames an export and updates all import bindings. Verify usage sites in importing files still work (the alias pattern `import { newName as oldName }` should preserve them).

2. **extract-common** — Extracts duplicate declarations into a shared location. Verify `import type` is used for type-only extractions. Verify the canonical copy gets `export` added.

3. **move** — Moves a file and updates all references. Verify internal imports in the moved file are updated. Verify barrel re-exports are handled. Check for false-positive barrel additions to `index.ts`.

4. **alias** — Normalizes import specifiers. Verify only module specifiers are changed (not `Bun.file()` paths, URLs, or config strings). Verify quote style is preserved.

## Step 6: Commit All Fixes

After all commands pass against the target project:

1. Run resect's full quality suite: `pnpm typecheck && pnpm lint && pnpm test`
2. Commit each fix separately with a descriptive message
3. Push and verify CI passes

## Checklist

For each command tested, record:

- [ ] Diff inspected — all changes correct
- [ ] Build passes after refactor
- [ ] No non-module strings modified
- [ ] Type imports use `import type` where appropriate
- [ ] Bugs found → fixed → verified → committed

## Example Session (Zustand)

```bash
# Clone and install
git clone --depth 1 https://github.com/pmndrs/zustand.git /tmp/zustand
pnpm --dir /tmp/zustand install

# Baseline build
pnpm --dir /tmp/zustand run build

# Discover structure
bun src/cli.ts discover /tmp/zustand
bun src/cli.ts audit /tmp/zustand/src
bun src/cli.ts similar /tmp/zustand/src --bucket=exact --format=compact

# Test rename
bun src/cli.ts rename /tmp/zustand/src/vanilla.ts createStore createVanillaStore --force --no-verify
git -C /tmp/zustand diff
pnpm --dir /tmp/zustand run build
git -C /tmp/zustand checkout -- .

# Test extract-common (duplicate Write type across 6 files)
bun src/cli.ts extract-common /tmp/zustand/src --group=2 --force --kinds=type
git -C /tmp/zustand diff
pnpm --dir /tmp/zustand run build
git -C /tmp/zustand checkout -- .

# Test move
bun src/cli.ts move /tmp/zustand/src/middleware/combine.ts /tmp/zustand/src/middleware/utils/combine.ts --force --no-verify
git -C /tmp/zustand diff
pnpm --dir /tmp/zustand run build
git -C /tmp/zustand checkout -- . && git -C /tmp/zustand clean -fd

# Test alias
bun src/cli.ts alias /tmp/zustand/src --prefer=shortest --force --no-verify -p /tmp/zustand/tsconfig.json
git -C /tmp/zustand diff
pnpm --dir /tmp/zustand run build
git -C /tmp/zustand checkout -- .
```

## Bugs Found in Previous Runs

### rename: local binding broken (fixed in 89c9f0f)
**Symptom**: `import { createStore }` became `import { createVanillaStore }` but all call sites still used `createStore`, breaking the code.
**Fix**: Changed to `import { createVanillaStore as createStore }` to preserve local binding names.

### extract-common: types not located in AST (fixed in f1940bf)
**Symptom**: `findFunctionNode` only handled `FunctionDeclaration` and `VariableStatement`, so duplicate type aliases and interfaces couldn't be extracted.
**Fix**: Added `TypeAliasDeclaration` and `InterfaceDeclaration` handlers. Also added `import type` / `export type` for type-only re-exports.
