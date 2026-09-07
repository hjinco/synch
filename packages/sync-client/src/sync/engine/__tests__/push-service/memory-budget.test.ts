import { describe, expect, it } from "vitest";
import { SyncContentRuntime } from "../../../core/content-runtime";
import { BytesInFlightBudget } from "../../../core/bytes-in-flight";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { hashBytes } from "../../../core/content";
import { SyncPushService } from "../../push-service";
import { createPushSession, createToken, encryptMutationMetadata, TEST_VAULT_KEY } from "./helpers";

async function fixture(failCommit: boolean) {
  const store = createTestSyncStore();
  const budget = new BytesInFlightBudget(30);
  const runtime = new SyncContentRuntime({ byteBudget: budget });
  const files = new Map<string, Uint8Array>();
  for (const [i, size] of [20, 80, 10, 10].entries()) {
    const path = `${i}.md`;
    const bytes = new Uint8Array(size).fill(65 + i);
    files.set(path, bytes);
    const hash = await hashBytes(bytes);
    await store.markEntryDirty({
      mutationId: `mutation-${i}`, entryId: `entry-${i}`, op: "upsert", baseRevision: 0,
      blobId: `blob-${i}`, hash, createdAt: i,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: `entry-${i}`, baseRevision: 0, op: "upsert", blobId: `blob-${i}`, path, hash,
      }),
    });
  }
  const reads: string[] = [];
  const service = new SyncPushService({
    contentRuntime: runtime, getSyncStore: () => store, getSyncToken: async () => createToken(),
    getRemoteVaultKey: () => TEST_VAULT_KEY, prepareConcurrency: 4,
    fileReader: {
      getFileSize: async (path) => files.get(path)!.byteLength,
      readBytes: async (path) => {
        reads.push(path);
        const bytes = files.get(path)!;
        if (bytes.byteLength > 30) expect(budget.bytesInFlight).toBe(bytes.byteLength);
        else expect(budget.bytesInFlight).toBeLessThanOrEqual(30);
        return bytes.slice();
      },
    },
    blobClient: { uploadBlob: async () => { expect(budget.bytesInFlight).toBeGreaterThan(0); } },
  });
  let cursor = 0;
  const session = createPushSession(async (mutation) => {
    // The reservation must survive preparation, ready-queueing and acknowledgement.
    expect(budget.bytesInFlight).toBeGreaterThan(0);
    if (failCommit) throw new Error("commit failed");
    return { cursor: ++cursor, entryId: mutation.entryId, revision: 1 };
  });
  return { store, budget, runtime, service, session, reads };
}

describe("push source-byte budget", () => {
  it("keeps reservations through commit and admits oversized files alone", async () => {
    const f = await fixture(false);
    try {
      await expect(f.service.pushPendingMutations(f.session)).resolves.toMatchObject({ mutationsPushed: 4 });
      // Concurrent metadata preparation can change reservation arrival order.
      expect([...f.reads].sort()).toEqual(["0.md", "1.md", "2.md", "3.md"]);
      expect(f.budget.bytesInFlight).toBe(0);
      expect(f.budget.pendingReservations).toBe(0);
    } finally { await f.runtime.dispose(); await f.store.close(); }
  });
  it("releases ready results before joining blocked preparation after a commit failure", async () => {
    const f = await fixture(true);
    try {
      await expect(f.service.pushPendingMutations(f.session)).rejects.toThrow("commit failed");
      expect(f.budget.bytesInFlight).toBe(0);
      expect(f.budget.pendingReservations).toBe(0);
      expect(await f.store.listDirtyEntries()).toHaveLength(4);
    } finally { await f.runtime.dispose(); await f.store.close(); }
  });
});
