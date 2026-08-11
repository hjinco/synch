import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService tombstones", () => {
  it("applies retained delete tombstones for old clients without a full rebuild", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/note.md": "local stale body",
      "Local/orphan.md": "local orphan",
    });
    const suppressionCalls: string[][] = [];
    await store.setCursor(1);
    await store.upsertEntry({
      entryId: "entry-stale",
      path: "Folder/note.md",
      revision: 1,
      blobId: "old-blob",
      hash: "old-hash",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-stale",
      entryId: "entry-stale",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-local-pending",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-stale",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash: "local-hash",
      }),
      createdAt: 2,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 11,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 10,
              entryId: "entry-stale",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-stale",
                revision: 2,
                deleted: true,
                blobId: null,
                path: "Folder/note.md",
              }),
            }),
            createCommit({
              cursor: 11,
              entryId: "entry-catchup",
              revision: 1,
              blobId: "blob-catchup",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-catchup",
                revision: 1,
                blobId: "blob-catchup",
                path: "Folder/catchup.md",
                hash: await hashText("catchup body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-catchup": await encryptTestBlob(
          "blob-catchup",
          new TextEncoder().encode("catchup body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 11,
      entriesApplied: 2,
      filesWritten: 1,
      filesDeleted: 1,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/note.md")).toBeNull();
    expect(adapter.text("Folder/catchup.md")).toBe("catchup body");
    expect(adapter.text("Local/orphan.md")).toBe("local orphan");
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe(
      "local stale body",
    );
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getCursor()).toBe(11);
    expect(await store.getEntryById("entry-stale")).toMatchObject({
      path: "Folder/note.md",
      revision: 2,
      deleted: true,
    });
    expect((await store.getEntryById("entry-catchup"))?.revision).toBe(1);

    await store.close();
  });
});
