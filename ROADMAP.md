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
