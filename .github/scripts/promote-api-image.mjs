import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const revisionKey = "org.opencontainers.image.revision";
const fullSha = /^[a-f0-9]{40}$/;

// The calling workflow must serialize the inspection and promotion together.
export function promoteApiImage({ image, digest, revision, run = spawnSync }) {
	if (!image || !/^sha256:[a-f0-9]{64}$/.test(digest) || !fullSha.test(revision)) {
		throw new Error("An image, SHA-256 digest, and full Git revision are required.");
	}
	const command = (name, args) => run(name, args, { encoding: "utf8" });
	const checked = (name, args) => {
		const result = command(name, args);
		if (result.status !== 0) {
			throw new Error(`${name} failed: ${result.stderr || result.error || result.status}`);
		}
		return result.stdout;
	};
	const latest = `${image}:latest`;
	const inspected = command("docker", ["buildx", "imagetools", "inspect", latest, "--raw"]);
	if (inspected.status === 0) {
		const published = JSON.parse(inspected.stdout).annotations?.[revisionKey];
		if (!fullSha.test(published)) {
			throw new Error("latest has no valid revision annotation; refusing to replace it.");
		}
		// Checkout has full history. Unknown commits and rewritten histories are
		// errors, not permission to roll latest back.
		checked("git", ["cat-file", "-e", `${published}^{commit}`]);
		checked("git", ["cat-file", "-e", `${revision}^{commit}`]);
		const ancestor = (older, newer) => {
			const result = command("git", ["merge-base", "--is-ancestor", older, newer]);
			if (result.status !== 0 && result.status !== 1) {
				throw new Error(`Cannot compare published revisions: ${result.stderr}`);
			}
			return result.status === 0;
		};
		if (!ancestor(published, revision)) {
			if (ancestor(revision, published)) {
				return "kept-newer";
			}
			throw new Error("Published and candidate revisions have diverged; refusing to replace latest.");
		}
	} else {
		// Only an explicitly missing manifest is a first publication. Auth and
		// network failures must never be treated as an empty registry.
		const error = String(inspected.stderr || "");
		if (!/manifest unknown|MANIFEST_UNKNOWN|: not found\s*$/m.test(error)) {
			throw new Error(`Cannot inspect latest: ${error || inspected.error}`);
		}
	}
	checked("docker", ["buildx", "imagetools", "create", "--tag", latest, `${image}@${digest}`]);
	return "promoted";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.log(promoteApiImage({
		image: process.env.IMAGE,
		digest: process.env.IMAGE_DIGEST,
		revision: process.env.IMAGE_REVISION,
	}));
}
