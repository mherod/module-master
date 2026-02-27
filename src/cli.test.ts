import { describe, expect, test } from "bun:test";

describe("cli", () => {
	test("--version returns version", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "--version"]);
		const output = await new Response(proc.stdout).text();
		expect(output).toContain("resect v");
	});

	test("--help shows usage", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "--help"]);
		const output = await new Response(proc.stdout).text();
		expect(output).toContain("Usage:");
		expect(output).toContain("Commands:");
	});

	test("unknown command exits with error", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "unknown"]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
	});
});
