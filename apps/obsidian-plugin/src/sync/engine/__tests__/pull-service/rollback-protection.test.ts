import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import {
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

/**
 * A malicious or compromised sync server can replay an old, genuinely
 * encrypted-and-authenticated manifest entry - the AEAD proves the ciphertext
 * was produced for that (entryId, revision, op, blobId) tuple, but proves
 * nothing about whether it's current. The client is the only party that can
 * catch this, since the check has to hold even when the server itself is the
 * one lying.
 */
describe("SyncPullService rollback protection", () => {
  it("rejects a manifest entry whose revision is older than what's already known locally", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const path = "Folder/note.md";
    const currentBody = "current, newer content";
    const staleBody = "stale content from an old revision";
    const currentHash = await hashText(currentBody);
    const staleHash = await hashText(staleBody);

    // The client already fully synced this entry at revision 5.
    await store.setCursor(4);
    await store.upsertEntry({
      entryId: "entry-1",
      path,
      revision: 5,
      blobId: "blob-current",
      hash: currentHash,
      deleted: false,
      updatedAt: 1,
    });

    const adapter = createVaultAdapter({ [path]: currentBody });

    // The server replays an old, validly-encrypted revision 2 for the same entry.
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 5,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 5,
              entryId: "entry-1",
              revision: 2,
              blobId: "blob-stale",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 2,
                blobId: "blob-stale",
                path,
                hash: staleHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-stale": await encryptTestBlob("blob-stale", new TextEncoder().encode(staleBody)),
      },
    });

    const rollbacks: Array<{ entryId: string; localRevision: number; remoteRevision: number }> = [];
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onRollbackDetected(event) {
        rollbacks.push({
          entryId: event.entryId,
          localRevision: event.localRevision,
          remoteRevision: event.remoteRevision,
        });
      },
    });

    await service.pullOnce(session);

    expect(rollbacks).toEqual([
      { entryId: "entry-1", localRevision: 5, remoteRevision: 2 },
    ]);
    // The vault file must never have been touched with the stale content.
    expect(adapter.writes).not.toContain(path);
    expect(adapter.text(path)).toBe(currentBody);
    // The store's own record of the entry must stay at the newer revision.
    const stored = await store.getEntryById("entry-1");
    expect(stored?.revision).toBe(5);
    expect(stored?.hash).toBe(currentHash);
  });

  it("still applies a manifest entry whose revision matches or exceeds what's known locally", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const path = "Folder/note.md";
    const newerBody = "genuinely newer content";
    const newerHash = await hashText(newerBody);

    await store.setCursor(4);
    await store.upsertEntry({
      entryId: "entry-1",
      path,
      revision: 5,
      blobId: "blob-current",
      hash: await hashText("current content"),
      deleted: false,
      updatedAt: 1,
    });

    const adapter = createVaultAdapter({ [path]: "current content" });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 6,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 6,
              entryId: "entry-1",
              revision: 6,
              blobId: "blob-newer",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 6,
                blobId: "blob-newer",
                path,
                hash: newerHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-newer": await encryptTestBlob("blob-newer", new TextEncoder().encode(newerBody)),
      },
    });

    const rollbacks: unknown[] = [];
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onRollbackDetected: (event) => rollbacks.push(event),
    });

    await service.pullOnce(session);

    expect(rollbacks).toEqual([]);
    expect(adapter.text(path)).toBe(newerBody);
    const stored = await store.getEntryById("entry-1");
    expect(stored?.revision).toBe(6);
  });

  it("still applies a manifest entry whose revision exactly matches what's known locally (idempotent redelivery)", async () => {
    // A reconnect/full resync can legitimately re-send the entry's current
    // revision verbatim. The rollback check uses `<`, not `<=`, specifically
    // so this case still applies rather than being treated as a rollback.
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const path = "Folder/note.md";
    const currentBody = "current content";
    const currentHash = await hashText(currentBody);

    await store.setCursor(4);
    await store.upsertEntry({
      entryId: "entry-1",
      path,
      revision: 5,
      blobId: "blob-current",
      hash: currentHash,
      deleted: false,
      updatedAt: 1,
    });

    const adapter = createVaultAdapter({ [path]: currentBody });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 5,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 5,
              entryId: "entry-1",
              revision: 5,
              blobId: "blob-current",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 5,
                blobId: "blob-current",
                path,
                hash: currentHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-current": await encryptTestBlob("blob-current", new TextEncoder().encode(currentBody)),
      },
    });

    const rollbacks: unknown[] = [];
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onRollbackDetected: (event) => rollbacks.push(event),
    });

    await service.pullOnce(session);

    expect(rollbacks).toEqual([]);
    const stored = await store.getEntryById("entry-1");
    expect(stored?.revision).toBe(5);
  });
});
