import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const baseRef = args[0] ?? "origin/main";

if (args.length > 1 || baseRef === "--help" || baseRef === "-h") {
  console.log("Usage: pnpm bench:sync-client:compare [base-ref]");
  process.exit(args.length > 1 ? 1 : 0);
}

const temporaryRoot = await mkdtemp(join("/tmp", "synch-sync-client-compare-"));
const baseWorktree = join(temporaryRoot, "base");
const baselineReport = join(temporaryRoot, "base-benchmark.json");
const currentReport = join(temporaryRoot, "current-benchmark.json");
const baseFixture = join(temporaryRoot, "base-fixture", "1gb");
const currentFixture = join(temporaryRoot, "current-fixture", "1gb");
let worktreeAdded = false;

try {
  await run(
    "git",
    ["worktree", "add", "--detach", baseWorktree, baseRef],
    { cwd: repositoryRoot },
  );
  worktreeAdded = true;

  console.log(`\n[sync-client benchmark] running base ${baseRef}`);
  await run(
    "pnpm",
    [
      "-C",
      baseWorktree,
      "install",
      "--frozen-lockfile",
    ],
    { cwd: repositoryRoot },
  );
  await run(
    "pnpm",
    [
      "-C",
      join(baseWorktree, "packages/sync-client"),
      "exec",
      "vitest",
      "bench",
      "--run",
      "--config",
      "vitest.bench.config.mts",
      "--outputJson",
      baselineReport,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SYNCH_SYNC_CLIENT_FIXTURE_DIR: baseFixture,
      },
    },
  );

  console.log("\n[sync-client benchmark] running current worktree");
  await run(
    "pnpm",
    [
      "-C",
      join(repositoryRoot, "packages/sync-client"),
      "exec",
      "vitest",
      "bench",
      "--run",
      "--config",
      "vitest.bench.config.mts",
      "--compare",
      baselineReport,
      "--outputJson",
      currentReport,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SYNCH_SYNC_CLIENT_FIXTURE_DIR: currentFixture,
      },
    },
  );
} finally {
  if (worktreeAdded) {
    await run(
      "git",
      ["worktree", "remove", "--force", baseWorktree],
      { cwd: repositoryRoot, allowFailure: true },
    );
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const { allowFailure = false, ...spawnOptions } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => {
      if (allowFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || allowFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}`,
        ),
      );
    });
  });
}
