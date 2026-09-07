import { afterEach, describe, expect, it } from "vitest";
import { setRequestUrlMock } from "obsidian";

import { defaultHttpClient } from "./http";

describe("ObsidianHttpClient", () => {
  afterEach(() => {
    setRequestUrlMock(async () => {
      throw new Error("requestUrl mock is not configured");
    });
  });

  it("forwards requests to requestUrl without throwing on error status", async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    setRequestUrlMock(async (input) => {
      capturedRequest = input as Record<string, unknown>;
      return {
        status: 403,
        json: {
          error: "forbidden",
          message: "vault access denied",
        },
      };
    });

    const response = await defaultHttpClient.request({
      url: "http://127.0.0.1:8787/v1/sync/token",
      method: "POST",
      headers: {
        authorization: "Bearer session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-1" }),
    });

    expect(capturedRequest).toMatchObject({
      url: "http://127.0.0.1:8787/v1/sync/token",
      method: "POST",
      throw: false,
      headers: {
        authorization: "Bearer session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ vaultId: "vault-1" }),
    });
    expect(response.status).toBe(403);
    expect(response.json).toEqual({
      error: "forbidden",
      message: "vault access denied",
    });
  });

  it.each([[408, ""], [413, "<html>too large</html>"], [502, "bad gateway"]])(
    "preserves HTTP %i with a non-JSON error body", async (status, body) => {
      setRequestUrlMock(async () => ({ status, get json() { return JSON.parse(body); } }));
      const response = await defaultHttpClient.request({ url: "http://localhost/blob" });
      expect(response.status).toBe(status);
      expect(response.json).toBeUndefined();
    },
  );

  it("leaves successful JSON parsing strict and binary responses lazy", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    setRequestUrlMock(async () => ({ status: 200, arrayBuffer: bytes, get json() { throw new SyntaxError("invalid JSON"); } }));
    const response = await defaultHttpClient.request({ url: "http://localhost/blob" });
    expect(response.arrayBuffer).toBe(bytes);
    expect(() => response.json).toThrow(SyntaxError);
  });

  it("defaults the method to GET", async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    setRequestUrlMock(async (input) => {
      capturedRequest = input as Record<string, unknown>;
      return { status: 200 };
    });

    await defaultHttpClient.request({ url: "http://127.0.0.1:8787/health" });

    expect(capturedRequest).toMatchObject({
      url: "http://127.0.0.1:8787/health",
      method: "GET",
      throw: false,
    });
  });
});
