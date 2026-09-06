import { expect, it } from "vitest";
import { startServer } from "@synch/sync-testkit/server";
import { Worker } from "./worker";
import { runSample } from "./runner";
import { root } from "./cli";
import { scenarios } from "./profiles";

it("reaps a failed client worker and supports repeated disposal", async () => {
  const worker = new Worker();
  const pid = worker.processId;
  try { await expect(worker.call({ type: "sync" })).rejects.toThrow("not initialized"); }
  finally { await worker.close(); }
  await worker.close();
  expect(() => process.kill(pid, 0)).toThrow();
});
for (const runtime of ["node", "cloudflare"] as const) it(`closes ${runtime} server, releases its port and reaps its launcher`, async () => {
  const server = await startServer(runtime, root);
  expect((await fetch(`${server.baseUrl}/health`)).ok).toBe(true);
  await server.close();
  await server.close();
  await expect(fetch(`${server.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  expect(() => process.kill(server.processId, 0)).toThrow();
});
it("records an interrupted sample as failed and permits a subsequent isolated run", async () => {
  const controller = new AbortController();
  controller.abort(new Error("intentional lifecycle verification"));
  const failed = await runSample(root, "node", scenarios[3], false, controller.signal);
  expect(failed.status).toBe("failed");
  expect(failed.metrics).toBeNull();
  const passed = await runSample(root, "node", scenarios[3], false);
  expect(passed.status).toBe("passed");
});

it("kills a timed-out sync worker while leaving the owned server available for cleanup", async () => {
  const { signUp, createVault } = await import("@synch/sync-testkit/account");
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "synch-timeout-test-"));
  const server = await startServer("node", root);
  const worker = new Worker();
  try {
    const cookie = await signUp(server.baseUrl), vault = await createVault(server.baseUrl, cookie);
    await mkdir(join(directory, "vault"));
    await worker.call({ type: "init", directory: join(directory, "vault"), baseUrl: server.baseUrl, cookie, vaultId: vault.id, key: [...vault.key] });
    await expect(worker.call({ type: "measure", scenario: { ...scenarios[3], pageDelayMs: 60_000 } }, 50)).rejects.toThrow("timed out");
    await worker.close();
    expect(() => process.kill(worker.processId, 0)).toThrow();
    expect((await fetch(`${server.baseUrl}/health`)).ok).toBe(true);
  } finally { await worker.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
