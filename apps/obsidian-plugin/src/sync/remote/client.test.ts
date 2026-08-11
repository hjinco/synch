import { afterEach, describe, expect, it } from "vitest";
import { setRequestUrlMock } from "obsidian";

import { defaultHttpClient } from "../../http/request";
import { SyncAccessClient } from "@synch/sync-client/sync/remote/client";

describe("SyncAccessClient", () => {
  afterEach(() => {
    setRequestUrlMock(async () => {
      throw new Error("requestUrl mock is not configured");
    });
  });

  it("issues a sync token with the session bearer token and local vault payload", async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    setRequestUrlMock(async (input) => {
      capturedRequest = input as Record<string, unknown>;
      return {
        status: 200,
        json: {
          token: "sync-token-1",
          expiresAt: 1_700_000_120,
          vaultId: "vault-1",
          localVaultId: "local-vault-1",
          syncFormatVersion: 1,
        },
      };
    });

    const client = new SyncAccessClient(defaultHttpClient);
    const response = await client.issueSyncToken(
      "http://127.0.0.1:8787/",
      "session-token",
      {
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      },
    );

    expect(capturedRequest).toMatchObject({
      url: "http://127.0.0.1:8787/v1/sync/token",
      method: "POST",
      throw: false,
      headers: {
        authorization: "Bearer session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      }),
    });
    expect(response).toEqual({
      token: "sync-token-1",
      expiresAt: 1_700_000_120,
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
      syncFormatVersion: 1,
    });
  });

  it("surfaces API error messages on failed issuance", async () => {
    setRequestUrlMock(async () => ({
      status: 403,
      json: {
        error: "forbidden",
        message: "vault access denied",
      },
    }));

    const client = new SyncAccessClient(defaultHttpClient);

    await expect(
      client.issueSyncToken("http://127.0.0.1:8787", "session-token", {
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      }),
    ).rejects.toThrow("vault access denied");
  });
});
