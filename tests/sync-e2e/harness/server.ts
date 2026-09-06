import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const apiRoot = fileURLToPath(new URL("../../../apps/api/", import.meta.url));
export const testEmail = "sync-e2e@test.invalid";
export type Runtime = "node" | "cloudflare";
export interface TestServer { baseUrl: string; logs(): string; close(): Promise<void>; }

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Missing listening address");
  return address.port;
}

export async function startServer(runtime: Runtime): Promise<TestServer> {
  const port = await freePort();
  const directory = await mkdtemp(path.join(tmpdir(), `synch-sync-e2e-${runtime}-`));
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  let child: ChildProcess | undefined;
  // Do not inherit production credentials or local .env/.dev.vars files.
  const env = { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, TMPDIR: process.env.TMPDIR, CI: "true", WRANGLER_SEND_METRICS: "false" };
  function launch(command: string, args: string[], extra: Record<string, string> = {}) {
    const process = spawn(command, args, { cwd: directory, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    process.stdout?.on("data", chunk => { output += chunk; });
    process.stderr?.on("data", chunk => { output += chunk; });
    return process;
  }
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const vars = {
      BETTER_AUTH_SECRET: "e2e-auth-secret-only-for-isolated-local-tests",
      SYNC_TOKEN_SECRET: "e2e-sync-secret-only-for-isolated-local-tests", AUTH_ALLOWED_EMAILS: testEmail,
    };
    if (runtime === "node") {
      child = launch(path.join(apiRoot, "node_modules/.bin/tsx"), [path.join(apiRoot, "src/self-host.ts")], {
        ...vars, PUBLIC_URL: baseUrl, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: directory,
      });
    } else {
      const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", await readFile(path.join(apiRoot, "wrangler.jsonc"), "utf8"));
      if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
      const config = parsed.config;
      // Production community Worker/DO/D1/R2. Managed policy has separate API integration coverage.
      delete config.env;
      delete config.secrets;
      config.main = path.join(apiRoot, config.main);
      config.assets.directory = path.join(apiRoot, config.assets.directory);
      config.vars = { ...config.vars, ...vars, BETTER_AUTH_URL: baseUrl };
      config.d1_databases = config.d1_databases.map((db: Record<string, string>) => ({
        ...db, database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: path.join(apiRoot, db.migrations_dir),
      }));
      const configPath = path.join(directory, "wrangler.json");
      await writeFile(configPath, JSON.stringify(config));
      const wrangler = path.join(apiRoot, "node_modules/.bin/wrangler");
      child = launch(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", directory]);
      const migrationTimer = setTimeout(() => child?.kill("SIGTERM"), 30_000);
      let code: number | null;
      try { [code] = await once(child, "exit"); } finally { clearTimeout(migrationTimer); }
      if (code !== 0) throw new Error(`D1 migration failed: ${output}`);
      child = launch(wrangler, ["dev", "--local", "--config", configPath, "--persist-to", directory, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0"]);
    }
    const deadline = Date.now() + 60_000;
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { baseUrl, logs: () => output, close };
      } catch { /* Retry until ready. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server readiness timed out: ${output}`);
  } catch (error) { await close(); throw error; }
}
