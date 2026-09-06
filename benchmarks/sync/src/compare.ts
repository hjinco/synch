import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createReport, options, root, save } from "./cli";
import { assertComparable, renderReport, successful, type Report, type Comparison } from "./report";
import { runComparisonSample } from "./comparison-sample";

const active = new Set<ChildProcess>();
let interrupted = false;
function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function interrupt() {
  interrupted = true;
  for (const child of active) {
    terminate(child, "SIGTERM");
    const force = setTimeout(() => terminate(child, "SIGKILL"), 15_000);
    child.once("close", () => clearTimeout(force));
  }
}

function command(executable: string, args: string[], cwd: string, input?: string, cleanup = false): Promise<string> {
  if (interrupted && !cleanup) return Promise.reject(new Error("Comparison interrupted"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", env: { ...process.env, CI: "true" } });
    active.add(child);
    const deadline = setTimeout(() => terminate(child, "SIGTERM"), 20 * 60_000);
    const force = setTimeout(() => terminate(child, "SIGKILL"), 20 * 60_000 + 15_000);
    let output = "", errors = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { errors = (errors + bytes).slice(-16_384); });
    child.on("error", reject);
    child.on("close", code => {
      active.delete(child); clearTimeout(deadline); clearTimeout(force);
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${executable} exited ${code}: ${errors || output.slice(-2000)}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

/** Measurement dependencies are pinned without rewriting the product lockfile. */
async function stageDefinition(checkout: string, frozen: string) {
  for (const folder of ["benchmarks/sync", "packages/sync-testkit"]) {
    // These are isolated, owned checkouts. Remove old definitions before copying.
    await rm(join(checkout, folder), { recursive: true, force: true });
    await cp(join(frozen, folder), join(checkout, folder), { recursive: true });
    const manifest = JSON.parse(await readFile(join(frozen, folder, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.devDependencies)) {
      const link = join(checkout, folder, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      const target = name === "@synch/sync-testkit" ? join(checkout, "packages/sync-testkit")
        : name === "@synch/sync-client" ? join(checkout, "packages/sync-client")
        : name === "@synch/vault-crypto" ? join(checkout, "packages/vault-crypto")
        : await realpath(join(root, folder, "node_modules", name));
      await symlink(target, link, "dir");
    }
  }
}

async function main() {
  const config = options(process.argv.slice(2), true);
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const temporary = await mkdtemp(join(tmpdir(), "synch-bench-compare-"));
  const checkouts: string[] = [];
  try {
    const frozen = join(temporary, "definition");
    for (const folder of ["benchmarks/sync", "packages/sync-testkit"]) await cp(join(root, folder), join(frozen, folder), {
      recursive: true, filter: source => !source.split("/").includes("node_modules"),
    });
    const identities: Report["source"][] = [];
    for (const [name, ref] of [["base", config.base!], ["candidate", config.candidate!]]) {
      const working = ref === "working-tree";
      if (working && name !== "candidate") throw new Error("Only candidate may use working-tree");
      const commit = (await command("git", ["rev-parse", "--verify", `${working ? "HEAD" : ref}^{commit}`], root)).trim();
      const checkout = join(temporary, name);
      await command("git", ["worktree", "add", "--detach", checkout, commit], root);
      checkouts.push(checkout);
      console.log(`Preparing ${name}: ${commit}${working ? " + working tree" : ""}`);
      let dirtyHash: string | null = null;
      if (working) {
        dirtyHash = (await createReport(config)).source.dirtyHash;
        const patch = await command("git", ["diff", "HEAD", "--binary"], root);
        if (patch) await command("git", ["apply", "--binary", "-"], checkout, patch);
        const untracked = (await command("git", ["ls-files", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
        for (const file of untracked) {
          await mkdir(dirname(join(checkout, file)), { recursive: true });
          await cp(join(root, file), join(checkout, file));
        }
      }
      await command("pnpm", ["install", "--frozen-lockfile"], checkout);
      // Snapshot source metadata before overlaying measurement-only files.
      const { createHash } = await import("node:crypto");
      identities.push({ commit, dirtyHash, lockfile: createHash("sha256").update(await readFile(join(checkout, "pnpm-lock.yaml"))).digest("hex") });
      await stageDefinition(checkout, frozen);
    }
    const reports = await Promise.all(checkouts.map(checkout => createReport(config, checkout)));
    for (let i = 0; i < reports.length; i++) reports[i].source = identities[i];
    assertComparable(reports[0], reports[1]);
    const comparison: Comparison = { schemaVersion: 1, kind: "comparison", base: reports[0], candidate: reports[1] };
    await save(config.output, comparison);
    for (let s = 0; s < config.scenarios.length; s++) {
      for (let sample = -config.warmup; sample < config.iterations; sample++) {
        // Alternate the order within each sequential base/candidate pair.
        const order = (sample + config.warmup) % 2 ? [1, 0] : [0, 1];
        for (const side of order) {
          console.log(`${side ? "candidate" : "base"}: ${config.scenarios[s].id}, ${sample < 0 ? "rehearsal" : `sample ${sample + 1}`}`);
          const expected = { ...reports[side], options: { ...reports[side].options, iterations: 1, warmup: 0 }, scenarios: [{ scenario: config.scenarios[s], samples: [] }] };
          const result = await runComparisonSample(temporary, expected, sample < 0, output =>
            command(process.execPath, ["--import", "tsx", "src/cli.ts", "--runtime", config.runtime, "--scenario", config.scenarios[s].id, "--iterations", "1", "--warmup", "0", "--output", output], join(checkouts[side], "benchmarks/sync")));
          reports[side].scenarios[s].samples.push(result);
          await save(config.output, comparison);
          if (result.status === "failed") console.error(result.error);
        }
        assertComparable(reports[0], reports[1]);
        if (reports.some(r => r.scenarios[s].samples.some(v => v.status === "failed"))) break;
      }
    }
    console.log(renderReport(comparison));
    console.log(`Raw results: ${config.output}`);
    if (!reports.every(successful)) process.exitCode = 1;
  } finally {
    for (const checkout of checkouts.reverse()) await command("git", ["worktree", "remove", "--force", checkout], root, undefined, true);
    await rm(temporary, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
