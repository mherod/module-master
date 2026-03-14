/**
 * Public API for resect — runtime-agnostic TypeScript/JavaScript refactoring.
 *
 * Use `setRuntime(bunRuntime)` (default) or `setRuntime(nodeRuntime)` before
 * calling any command that touches the filesystem.
 */

export type { MoveOptions } from "./commands/move.ts";
// Commands
export { moveCommand, moveModule } from "./commands/move.ts";
export type {
	RenameOptions,
	RenameResult,
} from "./commands/rename.ts";
export {
	renameCommand,
	renameInSourceFile,
	renameSymbol,
} from "./commands/rename.ts";
export { buildDependencyGraph } from "./core/graph.ts";
// Core utilities
export { loadProject, resolveTsConfig } from "./core/project.ts";
export type { WorkspaceInfo, WorkspacePackage } from "./core/workspace.ts";
export { discoverWorkspace } from "./core/workspace.ts";
export type { FileSystem, GlobRunner, Runtime } from "./runtime/index.ts";
// Runtime abstraction
export {
	bunRuntime,
	getRuntime,
	nodeRuntime,
	setRuntime,
} from "./runtime/index.ts";
export type { ProjectConfig } from "./types.ts";
