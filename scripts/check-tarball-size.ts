#!/usr/bin/env bun
/**
 * Package-size guard. Packs the publishable tarball and fails if it exceeds
 * MAX_BYTES. Catches build artifacts (e.g. `bun --compile` binaries) leaking
 * into the published package via an over-broad `files` whitelist.
 *
 * Run standalone (`pnpm run verify:size`) or as the final `prepublishOnly`
 * gate. `pnpm pack` triggers prepack/prepare/postpack — never prepublishOnly —
 * so calling it from prepublishOnly does not recurse.
 */
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const toMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

const pkg = (await Bun.file(
	new URL("../package.json", import.meta.url)
).json()) as {
	name: string;
	version: string;
};

const dest = tmpdir();
await Bun.$`pnpm pack --pack-destination ${dest}`.quiet();

const tarballName = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
const tarballPath = join(dest, tarballName);

const { size } = await stat(tarballPath);
await unlink(tarballPath);

if (size > MAX_BYTES) {
	console.error(
		`❌ Published tarball is ${toMb(size)} MB, over the ${toMb(MAX_BYTES)} MB limit.`
	);
	console.error(
		'   A build artifact likely leaked in — check the "files" whitelist in package.json.'
	);
	process.exit(1);
}

console.log(
	`✅ Published tarball is ${toMb(size)} MB (limit ${toMb(MAX_BYTES)} MB).`
);
