export interface FileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	deleteFile(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface GlobRunner {
	glob(
		pattern: string,
		options: { cwd: string; absolute?: boolean }
	): AsyncIterable<string>;
}

/** Captured result of a child-process invocation. */
export interface ProcessResult {
	stdout: string;
	stderr: string;
	/** Process exit code, or null when the process failed to spawn. */
	exitCode: number | null;
}

/**
 * Abstraction over real process execution (tsc, git, …). Production runtimes
 * spawn a real child process; tests inject a fake that returns scripted
 * results, so the unit suite never spawns a subprocess.
 */
export interface ProcessRunner {
	exec(
		command: string[],
		options?: { cwd?: string; stdin?: string }
	): Promise<ProcessResult>;
}

export interface Runtime {
	fs: FileSystem;
	glob: GlobRunner;
	process: ProcessRunner;
}
