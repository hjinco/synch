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
