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
