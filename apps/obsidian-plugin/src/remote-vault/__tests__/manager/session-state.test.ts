import { describe, expect, it, vi } from "vitest";

import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import type { RemoteVaultBootstrapResponse } from "@synch/sync-client/remote-vault/types";
import { createManager } from "./helpers";

describe("RemoteVaultManager session state", () => {
  it("disconnects the current vault from this device", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const notify = vi.fn();
    const refreshUi = vi.fn();
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([1, 2, 3]),
    };

    const manager = createManager({
      storedVaultId: "vault-connected",
      storedVault,
      savedVaults,
      refreshUi,
      notify,
    });

    expect(manager.hasConnectedRemoteVault()).toBe(true);
    expect(manager.getRemoteVaultStatusLabel()).toBe(
      "A vault is stored on this device but not active.",
    );
    expect(manager.getRemoteVaultStatusLabel()).not.toContain("vault-connected");

    await manager.disconnectRemoteVault();

    expect(savedVaults[savedVaults.length - 1]).toBeNull();
    expect(manager.getActiveSession()).toBeNull();
    expect(notify).toHaveBeenCalledWith("Vault vault-connected disconnected from this device.");
    expect(refreshUi).toHaveBeenCalled();
  });

  it("restores a persisted vault session after sign-in", async () => {
    const refreshUi = vi.fn();
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([7, 8, 9]),
    };

    const manager = createManager({
      storedVaultId: "vault-restored",
      storedVault,
      refreshUi,
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => ({
          vault: {
            id: "vault-restored",
            name: "Restored",
            activeKeyVersion: 1,
            createdAt: "2026-04-22T00:00:00.000Z",
          },
          wrappers: [],
        }),
      },
    });

    await manager.restoreStoredSessionIfNeeded();

    expect(manager.getActiveSession()?.summary.vaultId).toBe("vault-restored");
    expect(manager.getActiveSession()?.summary.vaultName).toBe("Restored");
    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(storedVault.remoteVaultKey);
    expect(refreshUi).toHaveBeenCalled();
  });
});
