export { bunRuntime } from "./bun.ts";
export { nodeRuntime } from "./node.ts";
export type { FileSystem, GlobRunner, Runtime } from "./types.ts";

import { bunRuntime } from "./bun.ts";
import type { Runtime } from "./types.ts";

let _runtime: Runtime = bunRuntime;

export function getRuntime(): Runtime {
	return _runtime;
}

export function setRuntime(runtime: Runtime): void {
	_runtime = runtime;
}
