import { describe, expect, it, vi } from "vitest";

import type { HttpRequestInput, HttpResponseLike } from "../../http/request";
import { SyncBlobClient } from "./blob-client";
import { SyncAuthorizedRequestClient } from "./request-client";

describe("SyncBlobClient", () => {
  it.each(["upload", "download"] as const)(
    "refreshes authorization for a %s without changing the blob request",
    async (operation) => {
      const requests: HttpRequestInput[] = [];
      const bytes = new Uint8Array([1, 2, 3]);
      let token = "expired-token";
      const invalidateSyncToken = vi.fn(() => { token = "fresh-token"; });
      const client = new SyncBlobClient(new SyncAuthorizedRequestClient({
        getApiBaseUrl: () => "https://sync.example/",
        getSyncToken: async () => ({
          token,
          expiresAt: 1_000,
          vaultId: "vault/1",
          localVaultId: "local-1",
        }),
        invalidateSyncToken,
        httpClient: {
          async request(input) {
            requests.push(input);
            return requests.length === 1
              ? { status: 401 }
              : { status: 200, arrayBuffer: bytes.buffer };
          },
        },
      }));

      if (operation === "upload") {
        await client.uploadBlob("vault/1", "blob?1", bytes);
        for (const request of requests) {
          expect(request.body).toBe(bytes.buffer);
          expect(request.headers?.["x-blob-size"]).toBe("3");
        }
      } else {
        await expect(client.downloadBlob("vault/1", "blob?1")).resolves.toEqual(bytes);
      }

      expect(requests).toHaveLength(2);
      expect(invalidateSyncToken).toHaveBeenCalledTimes(1);
      for (const request of requests) {
        expect(request.url).toBe("https://sync.example/v1/vaults/vault%2F1/blobs/blob%3F1");
        expect(request.method).toBe(operation === "upload" ? "PUT" : "GET");
      }
      expect(requests.map((request) => request.headers?.authorization))
        .toEqual(["Bearer expired-token", "Bearer fresh-token"]);
    },
  );

  it("passes a full-buffer payload without making an upload copy", async () => {
    const requests: HttpRequestInput[] = [];
    const client = createBlobClient(requests);
    const bytes = new Uint8Array([1, 2, 3]);

    await client.uploadBlob(
      "vault-1",
      "blob-1",
      bytes,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe(bytes.buffer);
  });

  it("copies a view that does not cover its backing buffer", async () => {
    const requests: HttpRequestInput[] = [];
    const client = createBlobClient(requests);
    const backing = new Uint8Array([0, 1, 2, 3]);
    const bytes = backing.subarray(1, 3);

    await client.uploadBlob(
      "vault-1",
      "blob-1",
      bytes,
    );

    const body = requests[0]?.body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(body).not.toBe(backing.buffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2]);
  });
});

function createBlobClient(requests: HttpRequestInput[]): SyncBlobClient {
  const requestClient = new SyncAuthorizedRequestClient({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => ({
      token: "sync-token",
      expiresAt: 1_000,
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
    }),
    invalidateSyncToken: () => {},
    httpClient: {
      async request(input): Promise<HttpResponseLike> {
        requests.push(input);
        return { status: 201 };
      },
    },
  });

  return new SyncBlobClient(requestClient);
}
