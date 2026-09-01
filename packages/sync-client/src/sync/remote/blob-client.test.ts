import { describe, expect, it } from "vitest";

import type { HttpRequestInput, HttpResponseLike } from "../../http/request";
import { SyncBlobClient } from "./blob-client";
import { SyncAuthorizedRequestClient } from "./request-client";

describe("SyncBlobClient", () => {
  it("passes a full-buffer payload without making an upload copy", async () => {
    const requests: HttpRequestInput[] = [];
    const client = createBlobClient(requests);
    const bytes = new Uint8Array([1, 2, 3]);

    await client.uploadBlob(
      "http://127.0.0.1:8787",
      "sync-token",
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
      "http://127.0.0.1:8787",
      "sync-token",
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
