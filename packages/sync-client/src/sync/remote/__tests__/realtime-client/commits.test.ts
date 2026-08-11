import { describe, expect, it } from "vitest";

import { SyncRealtimeError } from "../../realtime-client";
import {
  createMutation,
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient commits", () => {
  it("routes commit rejections to the pending commit without reporting a background error", async () => {
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onError(error) {
          errors.push(error);
        },
      },
    });

    const commitPromise = session.commitMutation(createMutation());
    await waitForSentMessage(socket, 1);
    const commit = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "commit_mutations_committed",
      requestId: commit.requestId,
      cursor: 0,
      results: [
        {
          status: "rejected",
          mutationId: "mutation-1",
          entryId: "entry-1",
          code: "stale_revision",
          message: "expected base revision 3 but received 2",
          expectedBaseRevision: 3,
          receivedBaseRevision: 2,
        },
      ],
    });

    await expect(commitPromise).rejects.toBeInstanceOf(SyncRealtimeError);
    await expect(commitPromise).rejects.toMatchObject({
      code: "stale_revision",
      details: {
        expectedBaseRevision: 3,
        receivedBaseRevision: 2,
      },
    });
    expect(errors).toEqual([]);
  });

  it("keeps cursor advancement as a background event while a commit is pending", async () => {
    const cursors: number[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onCursorAdvanced(cursor) {
          cursors.push(cursor);
        },
      },
    });

    const commitPromise = session.commitMutation(createMutation());
    await waitForSentMessage(socket, 1);
    socket.emitMessage({ type: "cursor_advanced", cursor: 7 });
    const commit = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "commit_mutations_committed",
      requestId: commit.requestId,
      cursor: 8,
      results: [
        {
          status: "accepted",
          mutationId: "mutation-1",
          cursor: 8,
          entryId: "entry-1",
          revision: 1,
        },
      ],
    });

    await expect(commitPromise).resolves.toEqual({
      cursor: 8,
      entryId: "entry-1",
      revision: 1,
    });
    expect(cursors).toEqual([7]);
  });

  it("requests storage status watching and handles background storage updates", async () => {
    const storageStatuses: unknown[] = [];
    const { socket, session } = await openRealtimeSession({
      helloPolicy: {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 3_000_000,
      },
      callbacks: {
        onStorageStatusUpdated(status) {
          storageStatuses.push(status);
        },
      },
    });

    session.watchStorageStatus();
    expect(socket.sentMessageAt(1)).toMatchObject({
      type: "watch_storage_status",
    });

    socket.emitMessage({
      type: "storage_status_updated",
      storageStatus: {
        storageUsedBytes: 12_000_000,
        storageLimitBytes: 50_000_000,
      },
    });

    session.unwatchStorageStatus();
    expect(socket.sentMessageAt(2)).toMatchObject({
      type: "unwatch_storage_status",
    });

    expect(storageStatuses).toEqual([
      {
        storageUsedBytes: 12_000_000,
        storageLimitBytes: 1_000_000_000,
      },
    ]);
    expect(session.storageUsedBytes).toBe(12_000_000);
    expect(session.storageLimitBytes).toBe(1_000_000_000);
  });
});
