import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Bundles @synch/vault-crypto (shared with the Obsidian plugin via
// sync-client) into a single browser IIFE so the static public pages can run
// the exact same E2EE vault-key wrapping code. hash-wasm's argon2 build
// inlines its wasm as base64, so the output is self-contained - no CDN or
// network fetch involved.
//
// The output is committed because apps/api is copied by Deploy to Cloudflare
// as a standalone repository, without the surrounding pnpm workspace. Use
// --check in CI to guarantee that the committed deployment artifact still
// matches the canonical workspace source.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.resolve(projectDir, "../../packages/vault-crypto/src/index.ts");
const outfile = path.join(projectDir, "public", "vault-crypto.js");
const check = process.argv.slice(2).includes("--check");

const result = await build({
	entryPoints: [entryPoint],
	outfile,
	bundle: true,
	platform: "browser",
	format: "iife",
	globalName: "synchVaultCrypto",
	target: "es2020",
	minify: true,
	write: !check,
});

if (check) {
	const generated = result.outputFiles?.[0]?.contents;
	if (!generated) {
		throw new Error("esbuild did not return the generated vault crypto bundle");
	}

	let committed;
	try {
		committed = await readFile(outfile);
	} catch (error) {
		if (error?.code === "ENOENT") {
			console.error("public/vault-crypto.js is missing; run `pnpm run build:public`");
			process.exitCode = 1;
		} else {
			throw error;
		}
	}

	if (committed && !committed.equals(generated)) {
		console.error(
			"public/vault-crypto.js is stale; run `pnpm run build:public` and commit the result",
		);
		process.exitCode = 1;
	}
}
