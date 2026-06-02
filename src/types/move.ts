export interface MoveOperation {
	sourcePath: string;
	targetPath: string;
	dryRun: boolean;
}

export interface MoveResult {
	success: boolean;
	movedFile: { from: string; to: string };
	updatedReferences: UpdatedReference[];
	errors: MoveError[];
	/**
	 * Dependency entries added to the destination package.json on a
	 * cross-package move (issue #118). Absent/empty for same-package moves.
	 */
	dependencyChanges?: DependencyChange[];
}

export interface UpdatedReference {
	file: string;
	line: number;
	oldSpecifier: string;
	newSpecifier: string;
}

export interface MoveError {
	file: string;
	message: string;
	recoverable: boolean;
}

/** Which dependency map an entry belongs to. */
export type DependencyField = "dependencies" | "peerDependencies";

/**
 * A dependency entry added to a destination package.json during a
 * cross-package move (issue #118).
 */
export interface DependencyChange {
	/** Absolute path to the destination package.json being updated. */
	packageJsonPath: string;
	/** Package name, e.g. "lodash" or "@scope/core". */
	name: string;
	/** Semver range copied from the source package. */
	version: string;
	/** Destination map the entry lands in (mirrors the source's placement). */
	field: DependencyField;
}
