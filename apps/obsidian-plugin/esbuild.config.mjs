import { config as loadEnv } from "dotenv";
import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.join(pluginRoot, "dist");
loadEnv({ path: path.join(pluginRoot, ".env") });

const production = process.argv[2] === "production";
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR?.trim();
const injectedApiBaseUrl = process.env.API_BASE_URL?.trim() || "http://localhost:8787";

const emptyNodeBuiltinPlugin = {
  name: "empty-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:(fs|crypto)$/ }, (args) => ({
      path: args.path,
      namespace: "empty-node-builtin",
    }));

    build.onLoad({ filter: /.*/, namespace: "empty-node-builtin" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const shared = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  define: {
    __SYNCH_API_BASE_URL__: JSON.stringify(injectedApiBaseUrl),
  },
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: path.join(releaseDir, "main.js"),
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [emptyNodeBuiltinPlugin],
};

async function stageReleaseArtifacts() {
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.rm(path.join(releaseDir, "versions.json"), { force: true });
  await Promise.all([
    fs.copyFile(path.join(pluginRoot, "manifest.json"), path.join(releaseDir, "manifest.json")),
    fs.copyFile(path.join(pluginRoot, "styles.css"), path.join(releaseDir, "styles.css")),
  ]);
}

async function copyArtifacts() {
  if (!pluginDir) {
    return;
  }

  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(releaseDir, "main.js"), path.join(pluginDir, "main.js")),
    fs.copyFile(path.join(releaseDir, "manifest.json"), path.join(pluginDir, "manifest.json")),
    fs.copyFile(path.join(releaseDir, "styles.css"), path.join(pluginDir, "styles.css")),
  ]);
  console.log(`[synch] copied plugin bundle to ${pluginDir}`);
}

if (production) {
  await esbuild.build(shared);
  await stageReleaseArtifacts();
  await copyArtifacts();
} else {
  await stageReleaseArtifacts();
  const ctx = await esbuild.context(shared);
  await ctx.watch();
  await ctx.rebuild();
  await copyArtifacts();
  console.log("[synch] watching Obsidian plugin sources");
}
