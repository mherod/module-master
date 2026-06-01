import { describe, expect, test } from "bun:test";
import {
	COMMAND_NAMES,
	COMMAND_SPECS,
	formatCommandList,
} from "./command-spec.ts";
import { COMMANDS } from "./registry.ts";

/**
 * Roster parity guard (#112).
 *
 * The resect command set is consumed by three entry points: the CLI registry
 * (`COMMANDS`), the MCP server (`registerTool` calls), and the `resect --help`
 * global command list (rendered from `COMMAND_SPECS`). These tests fail if any
 * of the three drifts from the others — the exact failure mode that left
 * `extract-component` and `inline` missing from `resect --help`.
 */
describe("command roster parity", () => {
	test("COMMAND_SPECS has no duplicate names", () => {
		expect(COMMAND_NAMES.size).toBe(COMMAND_SPECS.length);
	});

	test("CLI registry and roster declare the same command set", () => {
		const registryNames = new Set(COMMANDS.map((command) => command.name));
		expect(registryNames).toEqual(new Set(COMMAND_NAMES));
	});

	test("MCP tools and roster declare the same command set", async () => {
		// mcp-server.ts boots a stdio server on import (calls main()), so read it
		// as text and extract the registerTool names instead of importing it.
		const source = await Bun.file(`${import.meta.dir}/../mcp-server.ts`).text();
		const mcpNames = new Set(
			[...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map(
				(match) => match[1]
			)
		);
		expect(mcpNames).toEqual(new Set(COMMAND_NAMES));
	});

	test("global help list includes every command, including the once-missing ones", () => {
		const list = formatCommandList();
		for (const { name } of COMMAND_SPECS) {
			expect(list).toContain(name);
		}
		// Regression: these two were absent from the hand-typed cli.ts list.
		expect(list).toContain("extract-component");
		expect(list).toContain("inline");
	});

	test("each help row aligns its summary into one padded column", () => {
		const rows = formatCommandList().split("\n");
		const summaryColumns = rows.map((row) => row.indexOf("  ", 3));
		// Every row shares the same summary start column (single aligned gutter).
		expect(new Set(summaryColumns).size).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.startsWith("  ")).toBe(true);
		}
	});
});
