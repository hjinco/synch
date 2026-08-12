// Contract tests for scripts/self-host-update.mjs, the sync step of the
// self-hosted "Update Synch server" workflow. The script is executed as a
// child process, exactly as the workflow runs it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/self-host-update.mjs",
);

let workDir: string;
let upstreamDir: string;
let repoDir: string;

function write(rootDir: string, relPath: string, contents: string) {
	const absPath = path.join(rootDir, relPath);
	mkdirSync(path.dirname(absPath), { recursive: true });
	writeFileSync(absPath, contents);
}

function read(rootDir: string, relPath: string) {
	return readFileSync(path.join(rootDir, relPath), "utf8");
}

function runSync() {
	const env = { ...process.env };
	delete env.GITHUB_STEP_SUMMARY;
	const result = spawnSync(process.execPath, [scriptPath, upstreamDir, repoDir], {
		encoding: "utf8",
		env,
	});
	expect(result.status).toBe(0);
	return `${result.stdout}${result.stderr}`;
}

beforeEach(() => {
	workDir = mkdtempSync(path.join(tmpdir(), "self-host-update-"));
	upstreamDir = path.join(workDir, "upstream");
	repoDir = path.join(workDir, "repo");
	mkdirSync(upstreamDir, { recursive: true });
	mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("self-host-update sync script", () => {
	it("mirrors added, updated, and deleted files from upstream", () => {
		write(upstreamDir, "src/index.ts", "new entrypoint");
		write(upstreamDir, "src/added.ts", "added upstream");
		write(repoDir, "src/index.ts", "old entrypoint");
		write(repoDir, "src/removed.ts", "removed upstream");

		runSync();

		expect(read(repoDir, "src/index.ts")).toBe("new entrypoint");
		expect(read(repoDir, "src/added.ts")).toBe("added upstream");
		expect(existsSync(path.join(repoDir, "src/removed.ts"))).toBe(false);
	});

	it("preserves wrangler.jsonc and workflow files owned by the deployment", () => {
		write(upstreamDir, "wrangler.jsonc", '{ "name": "synch-api" }');
		write(
			upstreamDir,
			".github/workflows/self-host-update.yml",
			"name: Update Synch server # v2",
		);
		write(repoDir, "wrangler.jsonc", '{ "name": "my-api", "database_id": "abc" }');
		write(repoDir, ".github/workflows/self-host-update.yml", "name: Update Synch server # v1");

		runSync();

		expect(read(repoDir, "wrangler.jsonc")).toBe('{ "name": "my-api", "database_id": "abc" }');
		expect(read(repoDir, ".github/workflows/self-host-update.yml")).toBe(
			"name: Update Synch server # v1",
		);
	});

	it("keeps local-only artifacts that are not committed upstream", () => {
		write(upstreamDir, "src/index.ts", "entrypoint");
		write(repoDir, "src/index.ts", "entrypoint");
		write(repoDir, ".env", "SECRET=1");
		write(repoDir, ".dev.vars", "SECRET=2");
		write(repoDir, "node_modules/pkg/index.js", "module");

		runSync();

		expect(read(repoDir, ".env")).toBe("SECRET=1");
		expect(read(repoDir, ".dev.vars")).toBe("SECRET=2");
		expect(read(repoDir, "node_modules/pkg/index.js")).toBe("module");
	});

	it("mirrors committed .example files even though real env files are local-only", () => {
		write(upstreamDir, ".env.example", "KEY=updated");
		write(repoDir, ".env.example", "KEY=old");
		write(repoDir, ".dev.vars.example", "removed upstream");
		write(repoDir, ".env", "SECRET=1");

		runSync();

		expect(read(repoDir, ".env.example")).toBe("KEY=updated");
		expect(existsSync(path.join(repoDir, ".dev.vars.example"))).toBe(false);
		expect(read(repoDir, ".env")).toBe("SECRET=1");
	});

	it("mirrors the tracked browser crypto deployment artifact", () => {
		write(upstreamDir, "public/vault-crypto.js", "current bundle");
		write(repoDir, "public/vault-crypto.js", "stale bundle");

		runSync();

		expect(read(repoDir, "public/vault-crypto.js")).toBe("current bundle");
	});

	it("warns when upstream workflow files drift from the clone", () => {
		write(upstreamDir, ".github/workflows/self-host-update.yml", "v2");
		write(repoDir, ".github/workflows/self-host-update.yml", "v1");

		const output = runSync();

		expect(output).toContain("WARNING:");
		expect(output).toContain(".github/workflows/self-host-update.yml");
	});

	it("does not warn about workflows when the clone matches upstream", () => {
		write(upstreamDir, ".github/workflows/self-host-update.yml", "v1");
		write(repoDir, ".github/workflows/self-host-update.yml", "v1");

		const output = runSync();

		expect(output).not.toContain("WARNING:");
	});

	it("warns when the active workflow has not been installed", () => {
		write(upstreamDir, ".github/workflows/self-host-update.yml", "v1");

		const output = runSync();

		expect(output).toContain("WARNING:");
		expect(output).toContain(".github/workflows/self-host-update.yml");
	});

	it("warns about wrangler.jsonc only when upstream changes it after the first sync", () => {
		write(upstreamDir, "wrangler.jsonc", '{ "v": 1 }');
		write(repoDir, "wrangler.jsonc", '{ "v": 1, "database_id": "abc" }');

		// First sync establishes the baseline without warning: the clone's copy
		// always differs from upstream (resource ids), so a diff means nothing.
		const firstOutput = runSync();
		expect(firstOutput).not.toContain("WARNING:");

		// Unchanged upstream: still no warning.
		const secondOutput = runSync();
		expect(secondOutput).not.toContain("WARNING:");

		// Upstream change since the last sync triggers the warning, and the
		// clone's copy is still preserved.
		write(upstreamDir, "wrangler.jsonc", '{ "v": 2 }');
		const thirdOutput = runSync();
		expect(thirdOutput).toContain("WARNING:");
		expect(thirdOutput).toContain("wrangler.jsonc");
		expect(read(repoDir, "wrangler.jsonc")).toBe('{ "v": 1, "database_id": "abc" }');
	});

	it("reports no changes when the clone already matches upstream", () => {
		write(upstreamDir, "src/index.ts", "entrypoint");
		write(repoDir, "src/index.ts", "entrypoint");

		// First run may record sync state; the second run must be a no-op.
		runSync();
		const output = runSync();

		expect(output).not.toMatch(/^(add|update|delete): /m);
	});
});
