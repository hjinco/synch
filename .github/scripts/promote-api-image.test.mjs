import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promoteApiImage } from "./promote-api-image.mjs";

const repository = mkdtempSync(path.join(tmpdir(), "synch-image-promotion-"));
after(() => rmSync(repository, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
git("init", "--quiet");
git("config", "user.name", "Image promotion test");
git("config", "user.email", "test@example.com");
const commit = (file, contents) => {
	writeFileSync(path.join(repository, file), contents);
	git("add", file);
	git("commit", "--quiet", "-m", contents);
	return git("rev-parse", "HEAD");
};
const previous = commit("api.txt", "previous release");
const apiFix = commit("api.txt", "API fix A");
const docsOnly = commit("README.md", "docs-only B");
const newerApi = commit("api.txt", "API fix C");
git("checkout", "--quiet", "--detach", previous);
const divergent = commit("api.txt", "rewritten history");
git("checkout", "--quiet", "--detach", docsOnly);

const image = "ghcr.io/hjinco/synch-api";
const digest = `sha256:${"a".repeat(64)}`;
const manifest = (revision) => ({
	status: 0,
	stdout: JSON.stringify({ annotations: { "org.opencontainers.image.revision": revision } }),
});

function attempt(revision, inspection, promotionStatus = 0) {
	const creates = [];
	const run = (command, args, options) => {
		if (command === "git") {
			return spawnSync(command, args, { ...options, cwd: repository });
		}
		assert.equal(command, "docker");
		if (args[2] === "inspect") {
			assert.deepEqual(args, ["buildx", "imagetools", "inspect", `${image}:latest`, "--raw"]);
			return inspection;
		}
		creates.push(args);
		return { status: promotionStatus, stdout: "", stderr: "registry write failed" };
	};
	return {
		creates,
		execute: () => promoteApiImage({ image, digest, revision, run }),
	};
}

test("API fix publishes even after docs-only main commit, copying the exact index by digest", () => {
	assert.equal(git("rev-parse", "HEAD"), docsOnly);
	const result = attempt(apiFix, manifest(previous));
	assert.equal(result.execute(), "promoted");
	assert.deepEqual(result.creates, [["buildx", "imagetools", "create", "--tag", `${image}:latest`, `${image}@${digest}`]]);
});

test("older CI finishing late preserves a newer published API revision", () => {
	const result = attempt(apiFix, manifest(newerApi));
	assert.equal(result.execute(), "kept-newer");
	assert.deepEqual(result.creates, []);
});

test("same-commit rebuild can promote its new digest", () => {
	assert.equal(attempt(apiFix, manifest(apiFix)).execute(), "promoted");
});

test("first publication accepts an explicitly missing latest manifest", () => {
	for (const stderr of [`ERROR: ${image}:latest: not found`, "manifest unknown: manifest unknown"]) {
		assert.equal(attempt(apiFix, { status: 1, stderr }).execute(), "promoted");
	}
});

test("registry authentication and network failures do not overwrite latest", () => {
	for (const stderr of ["401 Unauthorized", "403 Forbidden", "TLS handshake timeout", "500 Internal Server Error"]) {
		const result = attempt(apiFix, { status: 1, stderr });
		assert.throws(result.execute, /Cannot inspect latest/);
		assert.deepEqual(result.creates, []);
	}
});

test("missing or invalid published metadata fails closed", () => {
	for (const revision of [undefined, "main", "--help"]) {
		const result = attempt(apiFix, manifest(revision));
		assert.throws(result.execute, /no valid revision/);
		assert.deepEqual(result.creates, []);
	}
});

test("divergent or unknown published history cannot be silently replaced", () => {
	for (const revision of [divergent, "f".repeat(40)]) {
		const result = attempt(apiFix, manifest(revision));
		assert.throws(result.execute, /diverged|git failed/);
		assert.deepEqual(result.creates, []);
	}
});

test("failed latest write fails the publication job", () => {
	assert.throws(attempt(apiFix, manifest(previous), 1).execute, /registry write failed/);
});
