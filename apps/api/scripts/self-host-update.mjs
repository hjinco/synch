// Syncs a self-hosted Synch server repository (created by the Deploy to
// Cloudflare button, with apps/api contents at the repository root) with the
// upstream apps/api tree.
//
// Usage: node self-host-update.mjs <upstream-api-dir> [repo-dir]
//
// The update workflow downloads the upstream tarball and runs THIS script from
// inside the tarball, so old clones always execute the latest sync logic. Only
// the thin workflow file itself is frozen (see PRESERVED paths below).
//
// Sync contract:
// - Regular files are mirrored from upstream: added, updated, and deleted.
// - `.github/workflows/**` is never touched. GitHub rejects pushes made with
//   GITHUB_TOKEN that create or update workflow files (`workflows` permission
//   cannot be granted to it), so the workflow warns instead when upstream
//   workflows drift from the clone.
// - `wrangler.jsonc` is never touched. The Deploy to Cloudflare button writes
//   user-specific resource state into it (Worker name, D1 database id, R2
//   bucket name); overwriting it could detach the deployment from its existing
//   database and bucket. The script tracks the upstream hash in a state file
//   and warns when upstream changes it, so users can apply changes manually.
//   Known limitation: the baseline hash is recorded on the first sync, so
//   upstream changes made between clone creation and the first update are
//   never flagged.
// - Local, non-committed artifacts (env files, node_modules, build output) are
//   left alone so the script is also safe to run in a working copy.
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

const PRESERVED_DIRS = [".github/workflows"];
const PRESERVED_FILES = ["wrangler.jsonc"];
const STATE_FILE = ".github/self-host-sync.json";

// Never deleted from the clone even when absent upstream: local artifacts and
// secrets that are gitignored upstream but may exist in a working copy.
const LOCAL_ONLY_DIRS = [".git", "node_modules", ".wrangler", "dist", "coverage"];
const LOCAL_ONLY_FILE_PREFIXES = [".env", ".dev.vars"];
const LOCAL_ONLY_FILES = [".DS_Store"];

function isPreserved(relPath) {
	return (
		PRESERVED_FILES.includes(relPath) ||
		PRESERVED_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`))
	);
}

function isLocalOnly(relPath) {
	if (relPath === STATE_FILE) return true;
	const segments = relPath.split("/");
	if (segments.some((segment) => LOCAL_ONLY_DIRS.includes(segment))) return true;
	const baseName = segments[segments.length - 1];
	// `.example` files (e.g. `.env.example`) are committed upstream, so they
	// must follow the normal mirror/delete lifecycle despite matching an env
	// file prefix.
	if (
		!baseName.endsWith(".example") &&
		LOCAL_ONLY_FILE_PREFIXES.some((prefix) => baseName.startsWith(prefix))
	) {
		return true;
	}
	if (LOCAL_ONLY_FILES.includes(relPath) || LOCAL_ONLY_FILES.includes(baseName)) return true;
	return false;
}

// Local-only directories are pruned during traversal so a working-copy run
// never descends into `.git` or `node_modules`.
function listFiles(rootDir, relDir = "") {
	const absDir = path.join(rootDir, relDir);
	const files = [];
	for (const entry of readdirSync(absDir, { withFileTypes: true })) {
		const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (LOCAL_ONLY_DIRS.includes(entry.name)) continue;
			files.push(...listFiles(rootDir, relPath));
		} else if (entry.isFile()) {
			files.push(relPath);
		}
	}
	return files;
}

function hashFile(absPath) {
	return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function filesDiffer(a, b) {
	if (!existsSync(a) || !existsSync(b)) return true;
	return !readFileSync(a).equals(readFileSync(b));
}

function copyFile(srcAbs, dstAbs) {
	mkdirSync(path.dirname(dstAbs), { recursive: true });
	writeFileSync(dstAbs, readFileSync(srcAbs));
	chmodSync(dstAbs, statSync(srcAbs).mode & 0o777);
}

function readState(repoDir) {
	const statePath = path.join(repoDir, STATE_FILE);
	if (!existsSync(statePath)) return {};
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return {};
	}
}

function writeState(repoDir, state) {
	const statePath = path.join(repoDir, STATE_FILE);
	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

const warnings = [];

function warn(message) {
	warnings.push(message);
	console.warn(`WARNING: ${message}`);
}

function main() {
	const [upstreamArg, repoArg] = process.argv.slice(2);
	if (!upstreamArg) {
		console.error("Usage: node self-host-update.mjs <upstream-api-dir> [repo-dir]");
		process.exit(2);
	}
	const upstreamDir = path.resolve(upstreamArg);
	const repoDir = path.resolve(repoArg ?? process.cwd());

	const upstreamFiles = listFiles(upstreamDir);
	const upstreamSet = new Set(upstreamFiles);
	const changes = [];

	// Mirror upstream files into the clone, skipping preserved paths.
	for (const relPath of upstreamFiles) {
		if (isPreserved(relPath) || relPath === STATE_FILE) continue;
		const srcAbs = path.join(upstreamDir, relPath);
		const dstAbs = path.join(repoDir, relPath);
		if (!existsSync(dstAbs)) {
			copyFile(srcAbs, dstAbs);
			changes.push(`add: ${relPath}`);
		} else if (filesDiffer(srcAbs, dstAbs)) {
			copyFile(srcAbs, dstAbs);
			changes.push(`update: ${relPath}`);
		}
	}

	// Delete clone files that no longer exist upstream, keeping preserved
	// paths and local-only artifacts.
	for (const relPath of listFiles(repoDir)) {
		if (upstreamSet.has(relPath) || isPreserved(relPath) || isLocalOnly(relPath)) continue;
		rmSync(path.join(repoDir, relPath));
		changes.push(`delete: ${relPath}`);
	}

	// Warn when the clone's workflow files are behind upstream. They cannot be
	// synced automatically because GITHUB_TOKEN cannot push workflow changes.
	for (const dir of PRESERVED_DIRS) {
		const upstreamWorkflowDir = path.join(upstreamDir, dir);
		if (!existsSync(upstreamWorkflowDir)) continue;
		for (const relPath of listFiles(upstreamDir, dir)) {
			if (filesDiffer(path.join(upstreamDir, relPath), path.join(repoDir, relPath))) {
				warn(
					`\`${relPath}\` changed upstream but cannot be updated automatically ` +
						"(GitHub Actions cannot push workflow file changes). Reinitialize it from " +
						"https://synch.run/self-hosting/.",
				);
			}
		}
	}

	// Warn when upstream changed wrangler.jsonc since the last sync. The
	// clone's copy holds user-specific resource ids, so it is never
	// overwritten; changes must be applied manually.
	const state = readState(repoDir);
	const previousHashes = { ...state.upstreamHashes };
	const upstreamHashes = {};
	for (const relPath of PRESERVED_FILES) {
		const srcAbs = path.join(upstreamDir, relPath);
		if (!existsSync(srcAbs)) continue;
		const hash = hashFile(srcAbs);
		upstreamHashes[relPath] = hash;
		const previous = previousHashes[relPath];
		if (previous !== undefined && previous !== hash) {
			warn(
				`\`${relPath}\` changed upstream since the last update. Your copy was kept ` +
					"because it contains your deployment's resource settings. Review " +
					`https://github.com/hjinco/synch/blob/main/apps/api/${relPath} and apply ` +
					"relevant changes manually.",
			);
		}
	}
	if (JSON.stringify(upstreamHashes) !== JSON.stringify(previousHashes)) {
		writeState(repoDir, { ...state, upstreamHashes });
		changes.push(`update: ${STATE_FILE}`);
	}

	for (const change of changes) {
		console.log(change);
	}
	if (changes.length === 0) {
		console.log("Already up to date.");
	}

	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		const lines = ["## Synch self-host update", ""];
		if (changes.length === 0) {
			lines.push("Already up to date.");
		} else {
			lines.push(`Synced ${changes.length} file change(s) from upstream.`);
		}
		if (warnings.length > 0) {
			lines.push("", "### Manual attention needed", "");
			for (const warning of warnings) {
				lines.push(`- ${warning}`);
			}
		}
		appendFileSync(summaryPath, `${lines.join("\n")}\n`);
	}
}

main();
