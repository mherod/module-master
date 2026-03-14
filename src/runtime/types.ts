export interface FileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	deleteFile(path: string): Promise<void>;
}

export interface GlobRunner {
	glob(
		pattern: string,
		options: { cwd: string; absolute?: boolean }
	): AsyncIterable<string>;
}

export interface Runtime {
	fs: FileSystem;
	glob: GlobRunner;
}
