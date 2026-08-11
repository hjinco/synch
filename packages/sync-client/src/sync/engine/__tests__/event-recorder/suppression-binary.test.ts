import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncEventGate } from "../../event-gate";
import { SyncEventRecorder } from "../../event-recorder";
import {
  decryptPendingMetadata,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncEventRecorder suppression and binary files", () => {
  it("ignores suppressed paths", async () => {
    const store = createTestSyncStore();
    const gate = new SyncEventGate();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      eventGate: gate,
    });

    await gate.suppressPaths(["Folder/file.md"], async () => {
      await recorder.recordUpsert("Folder/file.md", encodeUtf8("ignored"));
    });

    expect(await store.getEntryByPath("Folder/file.md")).toBeNull();
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it("tracks binary attachments with the same blob hash flow", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const imageBytes = new Uint8Array([0, 255, 1, 2, 3, 4]);

    await recorder.recordUpsert("Attachments/image.png", imageBytes);

    const entry = await store.getEntryByPath("Attachments/image.png");
    const pending = entry ? await store.getDirtyEntryMutation(entry.entryId) : null;
    const expectedHash = await hashBytes(imageBytes);

    expect(entry?.hash).toBe(expectedHash);
    expect(pending?.blobId).toEqual(expect.any(String));
    expect(pending?.hash).toBe(expectedHash);
    await expect(
      decryptPendingMetadata(pending),
    ).resolves.toEqual({
      path: "Attachments/image.png",
      hash: expectedHash,
    });

    await store.close();
  });
});
