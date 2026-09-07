import { describe, expect, it } from "vitest";

import type { HttpRequestInput, HttpResponseLike } from "../../http/request";
import { SyncAccessClient } from "./client";

describe("SyncAccessClient", () => {
  it("issues a sync token with the session bearer token and local vault payload", async () => {
    let capturedRequest: HttpRequestInput | null = null;
    const httpClient = createMockHttpClient(async (input) => {
      capturedRequest = input;
      return {
        status: 200,
        json: {
          token: "sync-token-1",
          expiresAt: 1_700_000_120,
          vaultId: "vault-1",
          localVaultId: "local-vault-1",
        },
      };
    });

    const client = new SyncAccessClient(httpClient);
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
    });
  });

  it.each([[503, "sync_paused"], [403, "forbidden"]])("preserves the vault link on a repair pause (%i)", async (status, code) => {
    const client = new SyncAccessClient(createMockHttpClient(async () => ({
      status, json: { error: code, message: "vault sync is temporarily paused for repair" },
    })));
    await expect(client.issueSyncToken("http://localhost", "token", { vaultId: "v", localVaultId: "l" }))
      .rejects.toMatchObject({ name: "ApiRequestError", status, code });
  });

  it("maps forbidden issuance failures to an access-denied vault error", async () => {
    const httpClient = createMockHttpClient(async () => ({
      status: 403,
      json: {
        error: "forbidden",
        message: "vault access denied",
      },
    }));

    const client = new SyncAccessClient(httpClient);

    await expect(
      client.issueSyncToken("http://127.0.0.1:8787", "session-token", {
        vaultId: "vault-1",
        localVaultId: "local-vault-1",
      }),
    ).rejects.toMatchObject({
      name: "RemoteVaultUnavailableError",
      reason: "access_denied",
      remoteVaultId: "vault-1",
    });
  });
});

function createMockHttpClient(
  handler: (input: HttpRequestInput) => Promise<HttpResponseLike>,
): { request(input: HttpRequestInput): Promise<HttpResponseLike> } {
  return {
    request: handler,
  };
}
