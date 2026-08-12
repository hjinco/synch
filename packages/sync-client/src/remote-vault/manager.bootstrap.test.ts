import { describe, expect, it } from "vitest";

import { createPasswordWrappedRemoteVaultKey } from "@synch/vault-crypto";
import type { StoredRemoteVaultKeySecret } from "./types";
import type {
  RemoteVaultBootstrapResponse,
  RemoteVaultSummaryResponse,
} from "./types";
import { createManager, remoteVaultSummary } from "./manager-test-helpers";

describe("RemoteVaultManager bootstrap", () => {
  it("lists remote vaults for bootstrap selection", async () => {
    const manager = createManager({
      remoteVaultClient: {
        listRemoteVaults: async (): Promise<RemoteVaultSummaryResponse> => ({
          vaults: [
            remoteVaultSummary(),
          ],
        }),
      },
    });

    const vaults = await manager.listRemoteVaults();

    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.id).toBe("vault-remote");
    expect(vaults[0]?.name).toBe("Remote");
  });

  it("connects the selected remote vault", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const createdWrapper = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });

    const manager = createManager({
      savedVaults,
      remoteVaultClient: {
        listRemoteVaults: async (): Promise<RemoteVaultSummaryResponse> => ({
          vaults: [
            remoteVaultSummary(),
          ],
        }),
        getRemoteVaultBootstrap: async (
          _apiBaseUrl: string,
          _sessionToken: string,
          vaultId: string,
        ): Promise<RemoteVaultBootstrapResponse> => ({
          vault: remoteVaultSummary({ id: vaultId }),
          wrappers: [
            {
              id: "wrapper-1",
              vaultId,
              keyVersion: 1,
              kind: "password",
              userId: "user-1",
              envelope: createdWrapper.envelope,
              createdAt: "2026-04-22T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        }),
      },
    });

    const summary = await manager.bootstrapRemoteVault({
      vaultId: "vault-remote",
      password: "vault-password",
    });

    expect(summary.vaultId).toBe("vault-remote");
    expect(summary.vaultName).toBe("Remote");
    expect(savedVaults[savedVaults.length - 1]?.remoteVaultKey).toBeInstanceOf(Uint8Array);
    expect(manager.getRemoteVaultStatus()).toEqual({
      state: "loaded",
      label: "Remote",
    });
  });

  it("reports a friendly error when the password cannot unwrap the vault key", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const createdWrapper = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });

    const manager = createManager({
      savedVaults,
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (
          _apiBaseUrl: string,
          _sessionToken: string,
          vaultId: string,
        ): Promise<RemoteVaultBootstrapResponse> => ({
          vault: remoteVaultSummary({ id: vaultId }),
          wrappers: [
            {
              id: "wrapper-1",
              vaultId,
              keyVersion: 1,
              kind: "password",
              userId: "user-1",
              envelope: createdWrapper.envelope,
              createdAt: "2026-04-22T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        }),
      },
    });

    await expect(
      manager.bootstrapRemoteVault({
        vaultId: "vault-remote",
        password: "wrong-password",
      }),
    ).rejects.toThrow("Unable to unlock vault. Check the password and try again.");
    expect(savedVaults).toEqual([]);
  });
});
