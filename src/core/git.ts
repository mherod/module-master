import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";

/**
 * Filter out files that are ignored by .gitignore.
 * Uses `git check-ignore` for accurate matching against all gitignore rules.
 * Falls back to returning the full list if git is unavailable.
 */
export async function filterGitignored(
	files: string[],
	scanDir?: string
): Promise<string[]> {
	if (files.length === 0) {
		return files;
	}

	try {
		const cwd = scanDir ?? path.dirname(files[0] ?? ".");

		// If the scan directory itself is gitignored, skip filtering
		// (user explicitly targeted this directory)
		const runtime = getRuntime();
		const dirCheck = await runtime.process.exec(
			["git", "check-ignore", "-q", cwd],
			{ cwd }
		);
		if (dirCheck.exitCode === 0) {
			return files;
		}

		const { stdout: output, exitCode } = await runtime.process.exec(
			["git", "check-ignore", "--stdin"],
			{ cwd, stdin: files.join("\n") }
		);

		if (exitCode !== 0 && exitCode !== 1) {
			return files;
		}

		const ignored = new Set(
			output
				.trim()
				.split("\n")
				.filter((l) => l.length > 0)
		);
		return files.filter((f) => !ignored.has(f));
	} catch {
		return files;
	}
}

/**
 * Check whether the git working tree at `dir` has uncommitted changes
 * (staged, unstaged, or untracked files).
 *
 * Returns `true` when the worktree is dirty, `false` when clean.
 * If `dir` is not inside a git repository, returns `false` (no-op).
 */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
	try {
		const { stdout, exitCode } = await getRuntime().process.exec(
			["git", "status", "--porcelain"],
			{ cwd: dir }
		);

		// Non-zero exit means git is not available or dir is not a repo
		if (exitCode !== 0) {
			return false;
		}

		return stdout.trim().length > 0;
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

/**
 * Roll back files to their committed state by discarding both staged and
 * worktree changes via `git restore --staged --worktree`.
 *
 * Used by mutating commands (tidy, mock-cleanup, alias, test-relocation) to
 * undo applied edits when post-change verification fails.
 *
 * @param dir - git working directory the restore runs in (typically project root)
 * @param files - paths to restore (absolute or relative to `dir`); no-op when empty
 * @throws when `git restore` exits non-zero
 */
export async function rollbackFiles(
	dir: string,
	files: readonly string[]
): Promise<void> {
	if (files.length === 0) {
		return;
	}

	const { stderr, exitCode } = await getRuntime().process.exec(
		["git", "restore", "--staged", "--worktree", "--", ...files],
		{ cwd: dir }
	);
	if (exitCode !== 0) {
		throw new Error(
			`Rollback failed: ${stderr.trim() || `git restore exited ${exitCode}`}`
		);
	}
}
