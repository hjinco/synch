import { describe, expect, it } from "vitest";

import {
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient listing", () => {
  it("lists entry-state delta pages over the realtime session", async () => {
    const { socket, session } = await openRealtimeSession();

    const statesPromise = session.listEntryStates({
      sinceCursor: 3,
      targetCursor: null,
      after: null,
      limit: 100,
    });
    await waitForSentMessage(socket, 1);
    const list = socket.sentMessageAt(1);
    expect(list).toMatchObject({
      type: "list_entry_states",
      sinceCursor: 3,
      targetCursor: null,
      after: null,
      limit: 100,
    });
    socket.emitMessage({
      type: "entry_states_listed",
      requestId: list.requestId,
      targetCursor: 10,
      totalEntries: 1,
      hasMore: false,
      nextAfter: null,
      entries: [
        {
          entryId: "entry-1",
          revision: 2,
          blobId: "blob-1",
          encryptedMetadata: "metadata",
          deleted: false,
          updatedSeq: 10,
          updatedAt: 10,
        },
      ],
    });

    await expect(statesPromise).resolves.toMatchObject({
      targetCursor: 10,
      totalEntries: 1,
      hasMore: false,
      entries: [{ entryId: "entry-1", updatedSeq: 10 }],
    });
  });

  it("lists entry history over the realtime session", async () => {
    const { socket, session } = await openRealtimeSession();

    const historyPromise = session.listEntryVersions({
      entryId: "entry-1",
      before: null,
      limit: 100,
    });
    await waitForSentMessage(socket, 1);
    const history = socket.sentMessageAt(1);
    expect(history).toMatchObject({
      type: "list_entry_versions",
      entryId: "entry-1",
      before: null,
      limit: 100,
    });
    socket.emitMessage({
      type: "entry_versions_listed",
      requestId: history.requestId,
      entryId: "entry-1",
      versions: [
        {
          versionId: "version-1",
          sourceRevision: 2,
          op: "upsert",
          blobId: "blob-1",
          encryptedMetadata: "metadata",
          reason: "auto",
          capturedAt: 4,
        },
      ],
      hasMore: false,
      nextBefore: null,
    });

    await expect(historyPromise).resolves.toMatchObject({
      entryId: "entry-1",
      hasMore: false,
      versions: [{ sourceRevision: 2 }],
    });
  });

  it("lists deleted entries over the realtime session", async () => {
    const { socket, session } = await openRealtimeSession();

    const deletedPromise = session.listDeletedEntries({
      before: { deletedAt: 10, entryId: "entry-older-than" },
      limit: 25,
    });
    await waitForSentMessage(socket, 1);
    const deleted = socket.sentMessageAt(1);
    expect(deleted).toMatchObject({
      type: "list_deleted_entries",
      before: { deletedAt: 10, entryId: "entry-older-than" },
      limit: 25,
    });
    socket.emitMessage({
      type: "deleted_entries_listed",
      requestId: deleted.requestId,
      entries: [
        {
          entryId: "entry-deleted",
          revision: 3,
          encryptedMetadata: "delete-metadata",
          deletedAt: 9,
        },
      ],
      hasMore: false,
      nextBefore: null,
    });

    await expect(deletedPromise).resolves.toEqual({
      entries: [
        {
          entryId: "entry-deleted",
          revision: 3,
          encryptedMetadata: "delete-metadata",
          deletedAt: 9,
        },
      ],
      hasMore: false,
      nextBefore: null,
    });
  });
});
