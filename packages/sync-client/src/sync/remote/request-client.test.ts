import { describe, expect, it, vi } from "vitest";

import type { HttpRequestInput, HttpResponseLike } from "../../http/request";
import type { SyncTokenResponse } from "./client";
import { SyncAuthorizedRequestClient } from "./request-client";

describe("SyncAuthorizedRequestClient", () => {
  it("adds the active sync token to sync requests", async () => {
    let capturedRequest: HttpRequestInput | null = null;
    const httpClient = createMockHttpClient(async (input) => {
      capturedRequest = input;
      return {
        status: 200,
        json: {
          ok: true,
        },
      };
    });
    const invalidateSyncToken = vi.fn();
    const client = new SyncAuthorizedRequestClient({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken("sync-token-1"),
      invalidateSyncToken,
      httpClient,
    });

    const result = await client.request({
      path: (token) => `/v1/vaults/${token.vaultId}/blobs/blob-1`,
      method: "GET",
    });

    expect(result.response.status).toBe(200);
    expect(capturedRequest).toMatchObject({
      url: "http://127.0.0.1:8787/v1/vaults/vault-1/blobs/blob-1",
      method: "GET",
      headers: {
        authorization: "Bearer sync-token-1",
      },
    });
    expect(invalidateSyncToken).not.toHaveBeenCalled();
  });

  it("invalidates the cached token and retries once after a 401", async () => {
    const capturedRequests: HttpRequestInput[] = [];
    const httpClient = createMockHttpClient(async (input) => {
      capturedRequests.push(input);
      if (capturedRequests.length === 1) {
        return {
          status: 401,
          json: {
            error: "unauthorized",
            message: "sync token expired",
          },
        };
      }

      return {
        status: 200,
        arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      };
    });
    const getSyncToken = vi.fn();
    getSyncToken.mockResolvedValueOnce(createToken("sync-token-1"));
    getSyncToken.mockResolvedValueOnce(createToken("sync-token-2"));
    const invalidateSyncToken = vi.fn();
    const client = new SyncAuthorizedRequestClient({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken,
      invalidateSyncToken,
      httpClient,
    });

    const result = await client.request({
      path: (token) => `/v1/vaults/${token.vaultId}/blobs/blob-1`,
      method: "PUT",
      headers: {
        "x-blob-size": "3",
      },
      body: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.response.status).toBe(200);
    expect(result.token.token).toBe("sync-token-2");
    expect(invalidateSyncToken).toHaveBeenCalledTimes(1);
    expect(getSyncToken).toHaveBeenCalledTimes(2);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]).toMatchObject({
      headers: {
        authorization: "Bearer sync-token-1",
        "x-blob-size": "3",
      },
    });
    expect(capturedRequests[1]).toMatchObject({
      headers: {
        authorization: "Bearer sync-token-2",
        "x-blob-size": "3",
      },
    });
  });

  it("does not retry indefinitely when the refreshed token is also rejected", async () => {
    const httpClient = createMockHttpClient(async () => ({
      status: 401,
      json: {
        error: "unauthorized",
        message: "sync token expired",
      },
    }));
    const getSyncToken = vi.fn();
    getSyncToken.mockResolvedValueOnce(createToken("sync-token-1"));
    getSyncToken.mockResolvedValueOnce(createToken("sync-token-2"));
    const invalidateSyncToken = vi.fn();
    const client = new SyncAuthorizedRequestClient({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken,
      invalidateSyncToken,
      httpClient,
    });

    const result = await client.request({
      path: () => "/v1/vaults/vault-1/blobs/blob-1",
    });

    expect(result.response.status).toBe(401);
    expect(result.token.token).toBe("sync-token-2");
    expect(invalidateSyncToken).toHaveBeenCalledTimes(1);
    expect(getSyncToken).toHaveBeenCalledTimes(2);
  });
});

function createMockHttpClient(
  handler: (input: HttpRequestInput) => Promise<HttpResponseLike>,
): { request(input: HttpRequestInput): Promise<HttpResponseLike> } {
  return {
    request: handler,
  };
}

function createToken(token: string): SyncTokenResponse {
  return {
    token,
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
  };
}
