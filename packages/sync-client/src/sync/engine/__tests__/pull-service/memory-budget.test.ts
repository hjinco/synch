import { describe, expect, it, vi } from "vitest";
import { BytesInFlightBudget } from "../../../core/bytes-in-flight";
import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPullService } from "../../pull-service";
import {
  createCommit, createRealtimeSession, createToken, createVaultAdapter,
  encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./helpers";

async function fixture(options: { legacy?: boolean; budget?: number; advertisedSize?: number; count?: number; concurrency?: number } = {}) {
  const body = "a".repeat(64);
  const blobs = await Promise.all(Array.from({ length: options.count ?? 3 }, (_, id) => id).map((id) =>
    encryptTestBlob(`blob-${id}`, new TextEncoder().encode(body))));
  const commits = await Promise.all(blobs.map(async (blob, id) => createCommit({
    cursor: id + 1, entryId: `entry-${id}`, blobId: `blob-${id}`, revision: 1,
    blobSize: options.legacy ? undefined : options.advertisedSize ?? blob.byteLength,
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: `entry-${id}`, revision: 1, blobId: `blob-${id}`,
      path: `${id}.md`, hash: await hashText(body),
    }),
  })));
  const store = createTestSyncStore();
  const adapter = createVaultAdapter();
  const budget = new BytesInFlightBudget(options.budget ?? blobs[0]!.byteLength * 3);
  const runtime = createTestContentRuntime({ byteBudget: budget });
  const downloads: string[] = [];
  const writes: string[] = [];
  let resolveWrite!: () => void;
  const writeGate = {
    promise: new Promise<void>((resolve) => { resolveWrite = resolve; }),
    resolve: () => resolveWrite(),
  };
  let blockWrite = false;
  let failWrite = false;
  const service = new SyncPullService({
    contentRuntime: runtime, getSyncToken: async () => createToken(),
    getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
    prepareConcurrency: options.concurrency ?? 2,
    vaultAdapter: {
      ...adapter,
      async writeText(path, text) {
        writes.push(path);
        if (path === "0.md" && blockWrite) await writeGate.promise;
        if (path === "1.md" && failWrite) throw new Error("write failed");
        await adapter.writeText(path, text);
      },
    },
    blobClient: { async downloadBlob(_vault, blobId) {
      downloads.push(blobId);
      return blobs[Number(blobId.split("-")[1])]!;
    } },
  });
  return {
    store, adapter, budget, downloads, writes, writeGate,
    blockWrite: () => { blockWrite = true; },
    failWrite: (value: boolean) => { failWrite = value; },
    pull: () => service.pullOnce(createRealtimeSession({ pages: [{ cursor: commits.length, hasMore: false, commits }] })),
  };
}

describe("pull payload memory admission", () => {
  it.each([291, 1])("holds a known group reservation through apply with budget %i", async (budget) => {
    const f = await fixture({ budget });
    f.blockWrite();
    const pull = f.pull();
    try {
      await vi.waitFor(() => expect(f.writes).toEqual(["0.md"]));
      expect(f.downloads).toEqual(["blob-0"]);
      expect(f.budget.bytesInFlight).toBe(291);
    } finally {
      f.writeGate.resolve();
      await pull;
    }
    expect(f.downloads).toEqual(["blob-0", "blob-1", "blob-2"]);
    expect(f.budget.bytesInFlight).toBe(0);
    expect(await f.store.getCursor()).toBe(3);
    await f.store.close();
  });

  it.each([2, 10])("keeps %i legacy downloads parallel, then stops admission as actual bytes accumulate", async (concurrency) => {
    const f = await fixture({ legacy: true, budget: 1, concurrency, count: concurrency + 1 });
    f.blockWrite();
    const pull = f.pull();
    try {
      await vi.waitFor(() => expect(f.writes).toEqual(["0.md"]));
      expect(f.downloads).toEqual(Array.from({ length: concurrency }, (_, id) => `blob-${id}`));
      expect(f.budget.bytesInFlight).toBe(291 * concurrency);
    } finally {
      f.writeGate.resolve();
      await pull;
    }
    expect(f.adapter.text("2.md")).toBe("a".repeat(64));
    expect(f.budget.bytesInFlight).toBe(0);
    await f.store.close();
  });

  it("rejects a mismatched advertised size without writing and releases queued work", async () => {
    const f = await fixture({ advertisedSize: 96, budget: 1 });
    await expect(f.pull()).rejects.toThrow("blob size does not match");
    expect(f.writes).toEqual([]);
    expect(f.budget.bytesInFlight).toBe(0);
    expect(await f.store.getCursor()).toBe(0);
    await f.store.close();
  });

  it("drains reservations on write failure and safely retries past completed groups", async () => {
    const f = await fixture({ budget: 1 });
    f.failWrite(true);
    await expect(f.pull()).rejects.toThrow("write failed");
    expect(f.budget.bytesInFlight).toBe(0);
    expect(await f.store.getCursor()).toBe(0);
    expect(await f.store.getEntryById("entry-0")).toMatchObject({ revision: 1 });
    f.failWrite(false);
    await f.pull();
    expect(f.downloads.filter((id) => id === "blob-0")).toHaveLength(1);
    expect(f.budget.bytesInFlight).toBe(0);
    expect(await f.store.getCursor()).toBe(3);
    await f.store.close();
  });
});
