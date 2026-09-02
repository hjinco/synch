import { describe, expect, it, vi } from "vitest";

import type { HttpClient, HttpRequestInput, HttpResponseLike } from "../http/request";
import { AuthClient } from "./client";

describe("AuthClient", () => {
  it("starts device authorization with the host client id", async () => {
    const { client, request } = createClient({
      status: 200,
      json: {
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://example.com/device",
        verification_uri_complete: "https://example.com/device?code=USER-CODE",
        expires_in: 600,
        interval: 5,
      },
    });

    await expect(client.startDeviceAuthorization("https://api.example.com/")).resolves.toEqual({
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://example.com/device",
      verificationUriComplete: "https://example.com/device?code=USER-CODE",
      expiresIn: 600,
      interval: 5,
    });
    expect(request).toHaveBeenCalledWith({
      url: "https://api.example.com/api/auth/device/code",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "synch-cli" }),
    });
  });

  it("surfaces the server error when device authorization is rejected", async () => {
    const { client } = createClient({
      status: 403,
      json: {
        code: "INVALID_ORIGIN",
        message: "Invalid origin",
      },
    });

    await expect(
      client.startDeviceAuthorization("https://api.example.com"),
    ).rejects.toThrow("device authorization failed with status 403: Invalid origin");
  });

  it("reports the status when a rejected device authorization has no error body", async () => {
    const { client } = createClient({ status: 502 });

    await expect(
      client.startDeviceAuthorization("https://api.example.com"),
    ).rejects.toThrow("device authorization failed with status 502");
  });

  it("maps pending and approved device token responses", async () => {
    const responses: HttpResponseLike[] = [
      {
        status: 400,
        json: {
          error: "authorization_pending",
          error_description: "Waiting for approval",
        },
      },
      {
        status: 200,
        json: {
          access_token: "session-token",
          expires_in: 3600,
          scope: "sync",
        },
      },
    ];
    const httpClient: HttpClient = {
      request: vi.fn(async () => responses.shift() ?? { status: 500 }),
    };
    const client = new AuthClient(httpClient, "synch-cli");

    await expect(
      client.pollDeviceAuthorization("https://api.example.com", "device-code"),
    ).resolves.toEqual({
      status: "pending",
      intervalMs: 5_000,
      message: "Waiting for approval",
    });
    await expect(
      client.pollDeviceAuthorization("https://api.example.com", "device-code"),
    ).resolves.toEqual({
      status: "approved",
      accessToken: "session-token",
      expiresIn: 3600,
      scope: "sync",
    });
  });
});

function createClient(response: HttpResponseLike): {
  client: AuthClient;
  request: ReturnType<typeof vi.fn<(input: HttpRequestInput) => Promise<HttpResponseLike>>>;
} {
  const request = vi.fn(async (_input: HttpRequestInput) => response);
  return {
    client: new AuthClient({ request }, "synch-cli"),
    request,
  };
}
