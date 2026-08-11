import { describe, expect, it } from "vitest";

import { SyncRealtimeError } from "../../realtime-client";
import {
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient restore", () => {
  it("routes restore failures to the pending request", async () => {
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onError(error) {
          errors.push(error);
        },
      },
    });

    const restorePromise = session.restoreEntryVersion({
      entryId: "entry-1",
      versionId: "version-1",
      baseRevision: 2,
      op: "upsert",
      blobId: "blob-1",
      encryptedMetadata: "ciphertext",
    });
    await waitForSentMessage(socket, 1);
    const restore = socket.sentMessageAt(1);
    expect(restore).toMatchObject({
      type: "restore_entry_version",
      entryId: "entry-1",
      versionId: "version-1",
      baseRevision: 2,
      op: "upsert",
      blobId: "blob-1",
      encryptedMetadata: "ciphertext",
    });
    socket.emitMessage({
      type: "entry_restore_failed",
      requestId: restore.requestId,
      code: "not_found",
      message: "requested revision was not found",
    });

    await expect(restorePromise).rejects.toBeInstanceOf(SyncRealtimeError);
    await expect(restorePromise).rejects.toMatchObject({ code: "not_found" });
    expect(errors).toEqual([]);
  });

  it("sends restore batches and returns per-entry results", async () => {
    const { socket, session } = await openRealtimeSession();

    const restorePromise = session.restoreEntryVersions([
      {
        entryId: "entry-1",
        versionId: "version-1",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-1",
        encryptedMetadata: "ciphertext",
      },
    ]);
    await waitForSentMessage(socket, 1);
    const restore = socket.sentMessageAt(1);
    expect(restore).toMatchObject({
      type: "restore_entry_versions",
      restores: [
        {
          entryId: "entry-1",
          versionId: "version-1",
          baseRevision: 2,
          op: "upsert",
          blobId: "blob-1",
          encryptedMetadata: "ciphertext",
        },
      ],
    });
    socket.emitMessage({
      type: "entry_versions_restored",
      requestId: restore.requestId,
      cursor: 4,
      results: [
        {
          status: "accepted",
          entryId: "entry-1",
          restoredFromVersionId: "version-1",
          restoredFromRevision: 1,
          cursor: 4,
          revision: 3,
        },
      ],
    });

    await expect(restorePromise).resolves.toEqual({
      cursor: 4,
      results: [
        {
          status: "accepted",
          entryId: "entry-1",
          restoredFromVersionId: "version-1",
          restoredFromRevision: 1,
          cursor: 4,
          revision: 3,
        },
      ],
    });
  });

  it("sends deleted entry purge batches and returns per-entry results", async () => {
    const { socket, session } = await openRealtimeSession();

    const purgePromise = session.purgeDeletedEntries([
      {
        entryId: "entry-1",
        revision: 3,
      },
    ]);
    await waitForSentMessage(socket, 1);
    const purge = socket.sentMessageAt(1);
    expect(purge).toMatchObject({
      type: "purge_deleted_entries",
      entries: [
        {
          entryId: "entry-1",
          revision: 3,
        },
      ],
    });
    socket.emitMessage({
      type: "deleted_entries_purged",
      requestId: purge.requestId,
      results: [
        {
          status: "accepted",
          entryId: "entry-1",
        },
      ],
    });

    await expect(purgePromise).resolves.toEqual({
      results: [
        {
          status: "accepted",
          entryId: "entry-1",
        },
      ],
    });
  });

  it("routes deleted entry purge failures to the pending request", async () => {
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onError(error) {
          errors.push(error);
        },
      },
    });

    const purgePromise = session.purgeDeletedEntries([
      {
        entryId: "entry-1",
        revision: 3,
      },
    ]);
    await waitForSentMessage(socket, 1);
    const purge = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "deleted_entries_purge_failed",
      requestId: purge.requestId,
      code: "purge_failed",
      message: "purge failed",
    });

    await expect(purgePromise).rejects.toBeInstanceOf(SyncRealtimeError);
    await expect(purgePromise).rejects.toMatchObject({ code: "purge_failed" });
    expect(errors).toEqual([]);
  });
});
