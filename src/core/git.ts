import { logger } from "../cli-logger.ts";

/**
 * Check whether the git working tree at `dir` has uncommitted changes
 * (staged, unstaged, or untracked files).
 *
 * Returns `true` when the worktree is dirty, `false` when clean.
 * If `dir` is not inside a git repository, returns `false` (no-op).
 */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "status", "--porcelain"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;

		// Non-zero exit means git is not available or dir is not a repo
		if (proc.exitCode !== 0) {
			return false;
		}

		return output.trim().length > 0;
	} catch {
		// git not installed or other system error — treat as non-git
		return false;
	}
}

/**
 * Guard that blocks mutating operations when the worktree is dirty.
 *
 * Call this before any file writes in mutating commands.
 * Exits the process with code 1 when blocked.
 *
 * @param dir - Directory to check (typically project root or cwd)
 * @param force - When true, skip the guard
 * @param dryRun - When true, skip the guard (dry runs don't mutate)
 */
export async function ensureCleanWorktree(
	dir: string,
	force?: boolean,
	dryRun?: boolean
): Promise<void> {
	if (force || dryRun) {
		return;
	}

	if (await isWorktreeDirty(dir)) {
		logger.error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
		process.exit(1);
	}
}
