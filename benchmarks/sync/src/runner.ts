import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "@synch/sync-testkit/server";
import { createVault, signUp } from "@synch/sync-testkit/account";
import { materialize } from "./fixtures";
import { Worker } from "./worker";
import type { Scenario, Runtime } from "./profiles";
import type { Sample } from "./report";

/** One server, store, and client process per sample. Seeding clients stay separate. */
export async function runSample(root: string, runtime: Runtime, scenario: Scenario, rehearsal: boolean, signal?: AbortSignal): Promise<Sample> {
  const directory = await mkdtemp(join(tmpdir(), "synch-benchmark-"));
  const workers = new Set<Worker>();
  let server: TestServer | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= (async () => {
    await Promise.allSettled([...workers].map(w => w.close()));
    await server?.close();
  })();
  const aborted = () => { void close(); };
  signal?.addEventListener("abort", aborted, { once: true });
  const started = performance.now();
  let measured = false;
  let verificationStart: number | undefined;
  const sample: Sample = { rehearsal, status: "failed", preparationMs: 0, verificationMs: 0, metrics: null, error: null, fixture: null, policy: null };
  try {
    signal?.throwIfAborted();
    server = await startServer(runtime, root);
    signal?.throwIfAborted();
    const cookie = await signUp(server.baseUrl);
    const remote = await createVault(server.baseUrl, cookie);
    const source = join(directory, "source");
    const fixture = await materialize(scenario.fixture, source);
    sample.fixture = { fingerprint: fixture.fingerprint, files: fixture.entries.length, bytes: fixture.bytes,
      changedBytes: scenario.operation === "incremental" ? fixture.entries.filter(e => e.changed).reduce((n, e) => n + e.size, 0) : fixture.bytes };
    const makeWorker = async (name: string, copy: boolean) => {
      signal?.throwIfAborted();
      const vaultDirectory = join(directory, name);
      await mkdir(vaultDirectory);
      if (copy) await cp(source, vaultDirectory, { recursive: true });
      const worker = new Worker(); workers.add(worker);
      const session = await worker.call<{ policy: NonNullable<Sample["policy"]> }>({ type: "init", directory: vaultDirectory, baseUrl: server!.baseUrl, cookie, vaultId: remote.id, key: [...remote.key] });
      if (!session.policy) throw new Error("Server did not advertise policy");
      sample.policy = session.policy;
      // Account for authenticated-encryption overhead and incremental history conservatively.
      const bytesNeeded = fixture.bytes * (scenario.operation === "incremental" ? 2 : 1) + fixture.entries.length * 1024;
      if ((session.policy.storageLimitBytes > 0 && bytesNeeded > session.policy.storageLimitBytes) ||
          (session.policy.maxFileSizeBytes > 0 && fixture.entries.some(e => e.size + 1024 > session.policy.maxFileSizeBytes))) throw new Error("Fixture exceeds advertised server policy");
      return worker;
    };
    let seed: Worker | undefined;
    let targetCursor = 0;
    if (scenario.operation !== "push") {
      seed = await makeWorker("seed", true);
      await seed.call({ type: "queue", paths: fixture.entries.map(e => e.path) });
      targetCursor = await seed.call<number>({ type: "sync" });
      if (scenario.operation !== "incremental") { await seed.close(); workers.delete(seed); }
    }
    const client = await makeWorker("client", scenario.operation === "push");
    if (scenario.operation === "push") await client.call({ type: "queue", paths: fixture.entries.map(e => e.path) });
    if (scenario.operation === "incremental") {
      await client.call({ type: "sync" });
      targetCursor = await seed!.call<number>({ type: "change", fixture });
      await seed!.close(); workers.delete(seed!);
    }
    signal?.throwIfAborted();
    sample.preparationMs = performance.now() - started;
    measured = true;
    const result = await client.call<{ metrics: NonNullable<Sample["metrics"]>; cursor: number; error?: string }>({ type: "measure", scenario });
    sample.metrics = { ...result.metrics, effectiveMiBPerSec: sample.fixture.changedBytes / 1024 ** 2 / (result.metrics.totalMs / 1000) };
    if (result.error) throw new Error(result.error);
    verificationStart = performance.now();
    targetCursor = scenario.operation === "push" ? result.cursor : targetCursor;
    if (result.cursor !== targetCursor) throw new Error("Measured client did not reach the seeded target");
    if (result.metrics.filesApplied !== (scenario.operation === "incremental" ? fixture.entries.filter(e => e.changed).length : fixture.entries.length)) throw new Error("Missing file completion observations");
    await client.call({ type: "verify", fixture, incremental: scenario.operation === "incremental", targetCursor });
    if (scenario.operation === "push") {
      const receiver = await makeWorker("verifier", false);
      await receiver.call({ type: "sync" });
      await receiver.call({ type: "verify", fixture, incremental: false, targetCursor });
    }
    sample.verificationMs = performance.now() - verificationStart;
    sample.status = "passed";
  } catch (error) {
    sample.error = String(error).slice(0, 2000);
    if (verificationStart !== undefined) sample.verificationMs = performance.now() - verificationStart;
    if (!measured) sample.preparationMs = performance.now() - started;
  } finally {
    signal?.removeEventListener("abort", aborted);
    try { await close(); }
    catch (error) { sample.status = "failed"; sample.error = `Cleanup failed: ${String(error)}`; }
    // A server may have finished starting after cancellation began.
    if (signal?.aborted) await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
  return sample;
}
