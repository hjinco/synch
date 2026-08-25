import { describe, expect, it, vi } from "vitest";

import { SyncTokenManager } from "./token-manager";
import type { SyncAccessClientLike } from "./token-manager";
import type { SyncTokenResponse } from "./client";

describe("SyncTokenManager", () => {
  it("issues a token for the active vault", async () => {
    const issueSyncToken = vi.fn(async (): Promise<SyncTokenResponse> => ({
      token: "sync-token-1",
      expiresAt: 1_000 + 120,
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
    }));
    const manager = createManager({
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    const token = await manager.getTokenForActiveRemoteVault();

    expect(token.token).toBe("sync-token-1");
    expect(issueSyncToken).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "session-token",
      {
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      },
    );
  });

  it("reuses a cached token before expiry", async () => {
    const issueSyncToken = vi.fn(async (): Promise<SyncTokenResponse> => ({
      token: "sync-token-1",
      expiresAt: 1_120,
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
    }));
    const manager = createManager({
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    const first = await manager.getTokenForActiveRemoteVault();
    const second = await manager.getTokenForActiveRemoteVault();

    expect(first).toBe(second);
    expect(issueSyncToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cached token is near expiry", async () => {
    const issueSyncToken = vi.fn();
    issueSyncToken.mockResolvedValueOnce({
        token: "sync-token-1",
        expiresAt: 1_010,
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      });
    issueSyncToken.mockResolvedValueOnce({
        token: "sync-token-2",
        expiresAt: 1_120,
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      });

    const manager = createManager({
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    const first = await manager.getTokenForActiveRemoteVault();
    const second = await manager.getTokenForActiveRemoteVault();

    expect(first.token).toBe("sync-token-1");
    expect(second.token).toBe("sync-token-2");
    expect(issueSyncToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the active vault changes", async () => {
    let vaultId = "vault-1";
    const issueSyncToken = vi.fn(async (
      _apiBaseUrl: string,
      _sessionToken: string,
      input: { vaultId: string; localVaultId: string },
    ): Promise<SyncTokenResponse> => ({
      token: `sync-token-${input.vaultId}`,
      expiresAt: 1_120,
      vaultId: input.vaultId,
      localVaultId: input.localVaultId,
    }));
    const manager = createManager({
      getRemoteVaultId: () => vaultId,
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    const first = await manager.getTokenForActiveRemoteVault();
    vaultId = "vault-2";
    const second = await manager.getTokenForActiveRemoteVault();

    expect(first.vaultId).toBe("vault-1");
    expect(second.vaultId).toBe("vault-2");
    expect(issueSyncToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the local vault id changes", async () => {
    let localVaultId = "local-vault-1";
    const issueSyncToken = vi.fn(async (
      _apiBaseUrl: string,
      _sessionToken: string,
      input: { vaultId: string; localVaultId: string },
    ): Promise<SyncTokenResponse> => ({
      token: `sync-token-${input.localVaultId}`,
      expiresAt: 1_120,
      vaultId: input.vaultId,
      localVaultId: input.localVaultId,
    }));
    const manager = createManager({
      getLocalVaultId: async () => localVaultId,
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    const first = await manager.getTokenForActiveRemoteVault();
    localVaultId = "local-vault-2";
    const second = await manager.getTokenForActiveRemoteVault();

    expect(first.localVaultId).toBe("local-vault-1");
    expect(second.localVaultId).toBe("local-vault-2");
    expect(issueSyncToken).toHaveBeenCalledTimes(2);
  });

  it("clears cached tokens explicitly", async () => {
    const issueSyncToken = vi.fn();
    issueSyncToken.mockResolvedValue({
        token: "sync-token",
        expiresAt: 1_120,
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      });
    const manager = createManager({
      now: () => 1_000_000,
      syncAccessClient: {
        issueSyncToken,
      },
    });

    await manager.getTokenForActiveRemoteVault();
    manager.clear();
    await manager.getTokenForActiveRemoteVault();

    expect(issueSyncToken).toHaveBeenCalledTimes(2);
  });

  it("rejects when there is no auth session", async () => {
    const manager = createManager({
      getAuthSessionToken: () => " ",
    });

    await expect(manager.getTokenForActiveRemoteVault()).rejects.toMatchObject({
      code: "not_signed_in",
    });
  });

  it("rejects when there is no active vault", async () => {
    const manager = createManager({
      getRemoteVaultId: () => null,
    });

    await expect(manager.getTokenForActiveRemoteVault()).rejects.toMatchObject({
      code: "no_active_vault",
    });
  });

  it("rejects when the local vault id is missing", async () => {
    const manager = createManager({
      getLocalVaultId: async () => " ",
    });

    await expect(manager.getTokenForActiveRemoteVault()).rejects.toMatchObject({
      code: "missing_local_vault_id",
    });
  });
});

function createManager(
  overrides: Partial<{
    getApiBaseUrl: () => string;
    getAuthSessionToken: () => string;
    getRemoteVaultId: () => string | null;
    getLocalVaultId: () => Promise<string>;
    syncAccessClient: SyncAccessClientLike;
    now: () => number;
  }> = {},
): SyncTokenManager {
  const syncAccessClient = overrides.syncAccessClient ?? {
    async issueSyncToken(): Promise<SyncTokenResponse> {
      throw new Error("this test should not issue a sync token");
    },
  };
  return new SyncTokenManager({
    getApiBaseUrl: overrides.getApiBaseUrl ?? (() => "http://127.0.0.1:8787"),
    getAuthSessionToken: overrides.getAuthSessionToken ?? (() => "session-token"),
    getRemoteVaultId: overrides.getRemoteVaultId ?? (() => "vault-1"),
    getLocalVaultId: overrides.getLocalVaultId ?? (async () => "local-vault-1"),
    syncAccessClient,
    now: overrides.now ?? (() => 1_000_000),
  });
}
