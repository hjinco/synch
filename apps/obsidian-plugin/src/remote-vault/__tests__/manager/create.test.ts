import { describe, expect, it } from "vitest";

import { createPasswordWrappedRemoteVaultKey } from "@synch/sync-client/remote-vault/crypto";
import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import type {
  CreateRemoteVaultResponse,
  RemoteVaultBootstrapResponse,
} from "@synch/sync-client/remote-vault/types";
import { createManager } from "./helpers";

describe("RemoteVaultManager create", () => {
  it("creates a vault and stores a loaded session", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const createCalls: Array<unknown> = [];
    const createdWrapper = await createPasswordWrappedRemoteVaultKey(
      "correct horse battery staple",
      {
        kdfOverrides: {
          memoryKiB: 8,
          iterations: 1,
          parallelism: 1,
        },
      },
    );

    const manager = createManager({
      savedVaults,
      remoteVaultClient: {
        createRemoteVault: async (
          _apiBaseUrl: string,
          _sessionToken: string,
          input: unknown,
        ): Promise<CreateRemoteVaultResponse> => {
          createCalls.push(input);
          return {
            vault: {
              id: "vault-created",
              name: "Personal",
              activeKeyVersion: 1,
              createdAt: "2026-04-22T00:00:00.000Z",
            },
          };
        },
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => ({
          vault: {
            id: "vault-created",
            name: "Personal",
            activeKeyVersion: 1,
            createdAt: "2026-04-22T00:00:00.000Z",
          },
          wrappers: [
            {
              id: "wrapper-1",
              vaultId: "vault-created",
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

    const summary = await manager.createRemoteVault({
      name: "Personal",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
    });

    expect(summary.vaultId).toBe("vault-created");
    expect(summary.vaultName).toBe("Personal");
    expect(savedVaults[savedVaults.length - 1]?.remoteVaultKey).toBeInstanceOf(Uint8Array);
    expect(manager.getActiveSession()?.summary.vaultId).toBe("vault-created");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      name: "Personal",
      initialWrapper: {
        kind: "password",
      },
    });
  });

  it("rejects weak passwords when creating a vault", async () => {
    const manager = createManager({});

    await expect(
      manager.createRemoteVault({
        name: "Personal",
        password: "vault-password",
        confirmPassword: "vault-password",
      }),
    ).rejects.toThrow("Password is too easy to guess. Use a longer passphrase.");
  });
});
