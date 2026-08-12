import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Bundles @synch/vault-crypto (shared with the Obsidian plugin via
// sync-client) into a single browser IIFE so the static public pages can run
// the exact same E2EE vault-key wrapping code. hash-wasm's argon2 build
// inlines its wasm as base64, so the output is self-contained - no CDN or
// network fetch involved. The output is gitignored; every dev/build/test
// entry point regenerates it via the `build:public` script.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = fileURLToPath(import.meta.resolve("@synch/vault-crypto"));

await build({
	entryPoints: [entryPoint],
	outfile: path.join(projectDir, "public", "vault-crypto.js"),
	bundle: true,
	platform: "browser",
	format: "iife",
	globalName: "synchVaultCrypto",
	target: "es2020",
	minify: true,
});
