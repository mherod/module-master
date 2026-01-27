# Roadmap

## Planned Commands

### `extract` - Extract symbol to new file

Extract a function, class, type, or component from an existing file into a new module, updating the original file to import from the new location.

```bash
module-master extract src/utils.ts parseConfig src/config/parser.ts
```

**Before:**
```ts
// src/utils.ts
export function parseConfig(raw: string) { ... }
export function formatOutput(data: Data) { ... }
```

**After:**
```ts
// src/utils.ts
export { parseConfig } from './config/parser';
export function formatOutput(data: Data) { ... }

// src/config/parser.ts (new file)
export function parseConfig(raw: string) { ... }
```

Use cases:
- Splitting large files into focused modules
- Moving a utility closer to its primary consumers
- Extracting shared code from a component into a separate module

---

### `barrel` - Generate and sync barrel files

Create or update index.ts barrel files that re-export from sibling modules. Supports different export styles and can sync with existing exports.

```bash
module-master barrel src/components           # Generate index.ts
module-master barrel src/utils --style=named  # Named exports only
module-master barrel src/hooks --sync         # Update existing barrel
```

**Generated:**
```ts
// src/components/index.ts
export { Button } from './Button';
export { Modal } from './Modal';
export { TextField } from './TextField';
export type { ButtonProps } from './Button';
```

Use cases:
- Establishing barrel file conventions in a directory
- Keeping barrel files in sync after adding new modules
- Converting between export styles (named vs wildcard)

---

### `unused` - Find unused exports

Scan the codebase to identify exports that are never imported. Helps clean up dead code and reduce bundle size.

```bash
module-master unused                     # Scan entire project
module-master unused src/utils           # Scan specific directory
module-master unused --ignore="*.test.ts"  # Exclude test files
module-master unused --remove            # Remove unused exports (destructive)
```

**Output:**
```
Unused exports found:

  src/utils/legacy.ts
    • formatLegacyDate (line 12)
    • parseLegacyFormat (line 45)

  src/components/Button.tsx
    • ButtonVariant (type, line 8)

  src/api/client.ts
    • deprecatedFetch (line 102)

4 unused exports in 3 files
```

Use cases:
- Identifying dead code before major refactors
- Cleaning up after removing features
- Auditing public API surface of a library

---

### `alias` - Normalize relative imports vs. path aliases

Rewrite import/export specifiers to either prefer `tsconfig` aliases or strict relative paths, ensuring the same module target and optionally updating nested re-exports.

```bash
module-master alias src --prefer=alias
module-master alias src --prefer=relative
module-master alias src/components/Button.tsx --prefer=alias --dry-run
```

Use cases:
- Standardizing import flavor (alias vs. relative) after upheavals like folder moves
- Eliminating brittle `../../../` chains by routing through defined aliases
- Making it explicit when a file must only touch public API layers

---

### `cycles` - Detect circular dependencies and link paths

Scan the dependency graph for cycles, report each edge, and optionally output JSON or even suggest breaking points.

```bash
module-master cycles
module-master cycles src --max-depth=50
module-master cycles --format=json
```

Use cases:
- Finding initialization/order bugs caused by circular imports
- Illuminating hidden coupling before large refactors
- Supporting engineering metrics that track cycle counts or module depth

---

### `graph` - Render dependency relationships

Export the project's dependency graph in human-readable or machine formats so teams can explore deep import trees, visualize hotspots, and feed diagrams into docs.

```bash
module-master graph
module-master graph src --depth=3 --format=dot > deps.dot
module-master graph src/components --format=json --include=barrels
```

Use cases:
- Show how a module flows through the codebase before moving or deleting it
- Generate DOT/JSON assets for documentation or architectural reviews
- Spot high-degree modules that form refactor candidates

---

### `orphan` - List or delete unreferenced modules

Detect TypeScript or JavaScript files that have zero incoming references (excluding test fixtures) so you can confidently retire them or gate their deletion behind a dry run.

```bash
module-master orphan
module-master orphan src/utils --ignore="*.test.ts" --dry-run
module-master orphan --delete
```

Use cases:
- Cleaning unused utilities, helpers, or legacy adapters
- Reducing bundle size in libraries by removing code that nobody imports
- Auditing files introduced by quick spikes before merging back to main

---

### `aggregate` - Merge exports into a single module

Combine several small modules into one target file while updating all imports/re-exports in the project, optionally collapsing barrels or applying a new public API surface.

```bash
module-master aggregate src/legacy/logger.ts src/legacy/metrics.ts --target=src/utils/logging.ts
module-master aggregate src/ui/icons/* --target=src/ui/icons/index.ts --dry-run
```

Use cases:
- Consolidating entry points for a library release
- Reducing the number of filesystem hops for hot paths
- Folding legacy helpers into a curated public module before deprecating the originals

---

### `doc` - Dump declaration JSDoc

Generate the full JSDoc comment for a top-level declaration so you can review it without opening the file or share the aligned docblock with others.

```bash
module-master doc src/utils/logger.ts logRequest
module-master doc src/index.ts --kind=function --format=markdown
module-master doc src/components/Button.tsx --verbose
```

Use cases:
- Quickly capture or sync documentation for exports you intend to rename or move
- Review prop/constants docs from a CLI before publishing or updating a README
- Export the docblock as markdown/JSON for changelog generation or automation
