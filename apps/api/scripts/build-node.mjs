import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await build({
	entryPoints: [path.join(projectDir, "src/self-host.ts")],
	outfile: path.join(outputDir, "server.mjs"),
	bundle: true,
	packages: "external",
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: true,
	loader: { ".sql": "text" },
});

await Promise.all(
	["drizzle", "drizzle-do", "public"].map((directory) =>
		cp(path.join(projectDir, directory), path.join(outputDir, directory), {
			recursive: true,
		}),
	),
);
