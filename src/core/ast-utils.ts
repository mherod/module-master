/**
 * Abstraction boundary for the TypeScript Compiler API.
 *
 * Command-layer files should import `ts` from here rather than directly from
 * `"typescript"`. This ensures that if the underlying parser ever changes,
 * only the `core/` layer needs to be updated.
 */
export { default } from "typescript";
