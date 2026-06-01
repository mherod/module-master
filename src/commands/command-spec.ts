/**
 * Single source of truth for the roster of resect commands.
 *
 * First slice of the per-command `CommandSpec` consolidation (#112). resect has
 * three entry points that each historically declared the command set on their
 * own: the CLI registry (`COMMANDS` in `registry.ts`), the MCP server (one
 * `registerTool` call per command in `mcp-server.ts`), and the `resect --help`
 * global command list (previously hand-typed in `cli.ts`). That third list had
 * already drifted — `extract-component` and `inline` were missing from
 * `resect --help` entirely.
 *
 * This module gives the roster one home: `cli.ts` now renders its global help
 * from `COMMAND_SPECS`, and `command-spec.test.ts` asserts the CLI registry,
 * the MCP tool set, and this roster stay in agreement so the three entry points
 * can never silently drift again.
 *
 * Remaining #112 work (later slices, intentionally NOT folded in here):
 *  - Carry per-command `cliHelp` (multi-line terminal usage) and
 *    `mcpDescription` (dense agent-facing prose) as separate fields so the
 *    `registry.ts` `helpText` and the MCP `registerTool` description derive
 *    from this declaration. They are different content by design and each
 *    already lives in exactly one place today.
 *  - Carry the positional-arg shape and option set so the MCP `registerTool`
 *    zod `inputSchema` and the CLI arg-validation derive from one place,
 *    reusing `option-flags.ts` / `option-domains.ts` / `ALL_TIDY_FIX_CATEGORIES`
 *    and preserving every CLI error string byte-for-byte.
 *  - Carry the dirty-worktree policy per command (unconditional block for
 *    move/rename/alias/inline/`naming --fix` vs `!dryRun`-gated for
 *    tidy/test-relocation/mock-cleanup) without normalising the variation.
 */

/** Canonical declaration of one resect command (roster slice). */
export interface CommandSpec {
	/** Command name exactly as typed on the CLI and registered as an MCP tool. */
	name: string;
	/**
	 * Argument signature shown after the name in the `resect --help` command
	 * list (e.g. `<file> <oldName> <newName>`). Empty string for none.
	 */
	usage: string;
	/** One-line description shown in the `resect --help` command list. */
	summary: string;
}

/**
 * The command roster, in `resect --help` presentation order (curated, not the
 * `registry.ts` execution order). `command-spec.test.ts` enforces that the set
 * of names here matches both the CLI registry and the MCP tool set.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
	{
		name: "find",
		usage: "<query> -p <project>",
		summary: "Find files and exports by name",
	},
	{
		name: "analyze",
		usage: "<file>",
		summary: "Analyze a module's imports, exports, and references",
	},
	{
		name: "discover",
		usage: "<directory>",
		summary: "Discover tsconfig files and project structure",
	},
	{
		name: "workspace",
		usage: "<directory>",
		summary: "Discover pnpm/yarn/npm workspace packages",
	},
	{
		name: "alias",
		usage: "<target> --prefer=<strategy>",
		summary: "Normalize imports to use aliases, relative paths, or shortest",
	},
	{
		name: "move",
		usage: "<source> <target>",
		summary: "Move a module and update all references",
	},
	{
		name: "rename",
		usage: "<file> <oldName> <newName>",
		summary: "Rename an export and update all imports",
	},
	{
		name: "similar",
		usage: "<directory>",
		summary: "Find similar or duplicate functions for consolidation",
	},
	{
		name: "extract-common",
		usage: "<directory>",
		summary: "Extract duplicate functions into shared modules",
	},
	{
		name: "extract-component",
		usage: "<file> <selector> <new-file>",
		summary: "Locate a JSX/TSX subtree to extract into a sub-component",
	},
	{
		name: "audit",
		usage: "<directory>",
		summary: "Analyze module health: fan-out, fan-in, cycles",
	},
	{
		name: "barrel",
		usage: "<directory>",
		summary: "Analyze barrel files: shadowing, wildcards, chains",
	},
	{
		name: "inline",
		usage: "<barrel-file>",
		summary: "Inline a re-export barrel into its importers",
	},
	{
		name: "unused",
		usage: "<directory>",
		summary: "Find exports never imported by other files",
	},
	{
		name: "mock-cleanup",
		usage: "<directory>",
		summary: "Find orphan keys in mock factories",
	},
	{
		name: "test-relocation",
		usage: "<directory>",
		summary: "Find stranded or misnamed test files",
	},
	{
		name: "naming",
		usage: "<directory>",
		summary: "Audit per-directory filename casing",
	},
	{
		name: "organise",
		usage: "<directory>",
		summary: "Audit folder organisation and basename collisions",
	},
	{
		name: "tidy",
		usage: "<directory>",
		summary: "Compose unused, similar, and audit reports",
	},
];

/** Set of all command names for fast membership and parity checks. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set(
	COMMAND_SPECS.map((spec) => spec.name)
);

/** The left column (`name` + ` ` + `usage`) for a spec's help row. */
function helpSignature(spec: CommandSpec): string {
	return spec.usage ? `${spec.name} ${spec.usage}` : spec.name;
}

/**
 * Render the `Commands:` block of `resect --help` from {@link COMMAND_SPECS},
 * aligning summaries into a single padded column. Two-space indented to match
 * the surrounding help layout.
 */
export function formatCommandList(
	specs: readonly CommandSpec[] = COMMAND_SPECS
): string {
	const columnWidth =
		Math.max(...specs.map((spec) => helpSignature(spec).length)) + 2;
	return specs
		.map(
			(spec) => `  ${helpSignature(spec).padEnd(columnWidth)}${spec.summary}`
		)
		.join("\n");
}
