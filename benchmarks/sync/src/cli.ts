import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { availableParallelism, cpus, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { selectScenarios, type Runtime } from "./profiles";
import { runSample } from "./runner";
import { renderReport, successful, type Report } from "./report";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export function options(args: string[], compare = false) {
  if (args[0] === "--") args = args.slice(1);
  const { values } = parseArgs({ args, options: {
    runtime: { type: "string", default: "cloudflare" }, suite: { type: "string", default: "quick" },
    scenario: { type: "string" }, iterations: { type: "string", default: "5" }, warmup: { type: "string", default: "1" },
    output: { type: "string", default: resolve(root, "benchmark-results", compare ? "comparison.json" : "run.json") },
    ...(compare ? { base: { type: "string" as const, default: "origin/main" }, candidate: { type: "string" as const, default: "working-tree" } } : {}),
  } });
  if (values.runtime !== "node" && values.runtime !== "cloudflare") throw new Error(`Unknown runtime: ${values.runtime}`);
  const iterations = Number(values.iterations), warmup = Number(values.warmup);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100 || !Number.isInteger(warmup) || warmup < 0 || warmup > 10) throw new Error("iterations must be 1..100; warmup must be 0..10");
  return { runtime: values.runtime as Runtime, scenarios: selectScenarios(values.suite!, values.scenario), iterations, warmup, output: resolve(values.output!), base: values.base as string | undefined, candidate: values.candidate as string | undefined };
}
export async function definitionFingerprint(checkout = root) {
  const hash = createHash("sha256");
  async function walk(directory: string) {
    for (const entry of (await readdir(join(checkout, directory), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "dist"].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else { hash.update(path); hash.update(await readFile(join(checkout, path))); }
    }
  }
  await walk("benchmarks/sync"); await walk("packages/sync-testkit");
  return hash.digest("hex");
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function createReport(config: ReturnType<typeof options>, checkout = root): Promise<Report> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" });
  const dirty = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort();
  const dirtyDigest = createHash("sha256").update(dirty);
  for (const path of untracked) { dirtyDigest.update(path); dirtyDigest.update(await readFile(join(checkout, path))); }
  const version = async (packagePath: string) => JSON.parse(await readFile(join(checkout, packagePath, "package.json"), "utf8")).version as string;
  return {
    schemaVersion: 1, kind: "run", runtime: config.runtime, definition: await definitionFingerprint(checkout),
    source: { commit: git("rev-parse", "HEAD").trim(), dirtyHash: dirty || untracked.length ? dirtyDigest.digest("hex") : null, lockfile: sha(await readFile(join(checkout, "pnpm-lock.yaml"))) },
    environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? "unknown", parallelism: availableParallelism(), store: "in-memory", vault: "filesystem", hashBackend: "node-webcrypto", cache: "OS-uncontrolled", rssSampleIntervalMs: 20, wrangler: await version("apps/api/node_modules/wrangler"), serverTsx: await version("apps/api/node_modules/tsx"), config: sha(await readFile(join(checkout, "apps/api/wrangler.jsonc"))) },
    options: { iterations: config.iterations, warmup: config.warmup, isolation: "fresh-process/prepared-session" },
    scenarios: config.scenarios.map(scenario => ({ scenario, samples: [] })),
  };
}
export async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(path + ".tmp", path);
}
export async function main() {
  const config = options(process.argv.slice(2));
  const report = await createReport(config);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Benchmark interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  await save(config.output, report);
  try {
    for (const group of report.scenarios) for (let i = -config.warmup; i < config.iterations; i++) {
      if (abort.signal.aborted) break;
      console.log(`[${config.runtime}] ${group.scenario.id} ${i < 0 ? "rehearsal" : `sample ${i+1}/${config.iterations}`}`);
      const sample = await runSample(root, config.runtime, group.scenario, i < 0, abort.signal);
      group.samples.push(sample);
      await save(config.output, report);
      if (sample.status === "failed") { console.error(sample.error); break; }
    }
    console.log(renderReport(report));
    console.log(`Raw results: ${config.output}`);
    if (!successful(report) || abort.signal.aborted) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
