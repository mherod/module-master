import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { extractCommonCommand } from "./extract-common.ts";

const baseFixtureDir = path.join(
	import.meta.dir,
	"__fixtures__/extract-common"
);
let testCounter = 0;

function nextFixtureDir(): string {
	testCounter++;
	return `${baseFixtureDir}-${testCounter}-${Date.now()}`;
}

async function setupFixtures(dir: string): Promise<void> {
	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
			include: ["*.ts"],
		})
	);
	await Bun.write(
		path.join(dir, "a.ts"),
		`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherA(): number {
  return 42;
}
`
	);
	await Bun.write(
		path.join(dir, "b.ts"),
		`function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherB(): number {
  return 99;
}
`
	);
}

function captureStdout(): { output: () => string; restore: () => void } {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buf = "";
	process.stdout.write = (chunk: string | Uint8Array) => {
		buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	};
	return {
		output: () => buf,
		restore: () => {
			process.stdout.write = originalWrite;
		},
	};
}

describe("extract-common", () => {
	test("dry-run reports duplicates without modifying files", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);
		const cap = captureStdout();

		try {
			await extractCommonCommand({
				directory: dir,
				threshold: 0.95,
				dryRun: true,
			});
		} finally {
			cap.restore();
		}

		const output = cap.output();
		expect(output).toContain("Dry run");
		expect(output).toContain("formatDate");
		expect(output).toContain("Would remove from");

		// Files should be unchanged
		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();
		expect(aContent).toContain("export function formatDate");
		expect(bContent).toContain("function formatDate");

		await rm(dir, { recursive: true, force: true });
	});

	test("extracts duplicates and adds imports", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			dryRun: false,
		});

		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// a.ts should still have the function (canonical)
		expect(aContent).toContain("export function formatDate");

		// b.ts should have an import instead of the function definition
		expect(bContent).not.toContain("function formatDate(input: Date)");
		expect(bContent).toContain('import { formatDate } from "./a"');
		// b.ts should still have its own function
		expect(bContent).toContain("export function otherB");

		await rm(dir, { recursive: true, force: true });
	});

	test("no groups found with different functions", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2020",
					module: "ESNext",
					strict: true,
				},
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(dir, "a.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}
`
		);
		await Bun.write(
			path.join(dir, "b.ts"),
			`export function completelyDifferent(x: number): boolean {
  for (let i = 0; i < x; i++) {
    if (i % 2 === 0) {
      console.log(i);
    }
  }
  return true;
}
`
		);

		const cap = captureStdout();
		try {
			await extractCommonCommand({
				directory: dir,
				threshold: 0.95,
				dryRun: true,
			});
		} finally {
			cap.restore();
		}

		expect(cap.output()).toContain("No similar function groups found");

		await rm(dir, { recursive: true, force: true });
	});
});
