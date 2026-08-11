import { describe, expect, it } from "vitest";

import {
  getOrCreateStoredLocalVaultId,
  readStoredSyncConnection,
  writeStoredSyncConnection,
} from "./connection";
import type { SyncConnection } from "./store";
import type { SyncConnectionStore } from "./ports";

describe("local vault id storage", () => {
  it("creates and persists a local vault id once", async () => {
    const store = createStore();

    const first = await getOrCreateStoredLocalVaultId(store, "remote-vault-a");
    const second = await getOrCreateStoredLocalVaultId(store, "remote-vault-a");

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(await readStoredSyncConnection(store)).toEqual({
      localVaultId: first,
      remoteVaultId: "remote-vault-a",
      lastPulledCursor: 0,
    });
  });

  it("writes and trims a stored local sync identity", async () => {
    const store = createStore();

    await writeStoredSyncConnection(store, {
      localVaultId: " local-vault-a ",
      remoteVaultId: " remote-vault-a ",
      lastPulledCursor: 12,
    });
    expect(await readStoredSyncConnection(store)).toEqual({
      localVaultId: "local-vault-a",
      remoteVaultId: "remote-vault-a",
      lastPulledCursor: 12,
    });
  });
});

function createStore(): SyncConnectionStore {
  let identity: SyncConnection | null = null;
  const localVaultId = crypto.randomUUID();

  return {
    async readLocalVaultId(): Promise<string> {
      return localVaultId;
    },
    async readSyncConnection(): Promise<SyncConnection | null> {
      return identity;
    },
    async writeSyncConnection(nextIdentity: SyncConnection): Promise<void> {
      identity = {
        localVaultId: nextIdentity.localVaultId.trim(),
        remoteVaultId: nextIdentity.remoteVaultId.trim(),
        lastPulledCursor: nextIdentity.lastPulledCursor,
      };
    },
  };
}
