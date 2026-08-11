import { describe, expect, it, vi } from "vitest";

import type { HttpClient, HttpRequestInput } from "../http/request";
import { BillingClient, parseBillingStatus } from "./client";

function createHttpClient(
  handler: (input: HttpRequestInput) => Promise<{ status: number; json: unknown }>,
): HttpClient {
  return {
    request: async (input) => {
      const response = await handler(input);
      return {
        status: response.status,
        json: response.json,
        text: "",
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      };
    },
  };
}

describe("BillingClient", () => {
  it("reads billing status with the auth session bearer token", async () => {
    const request = vi.fn(async (_input: HttpRequestInput) => ({
      status: 200,
      json: {
        planId: "starter",
        billingInterval: "monthly",
        active: true,
        status: "active",
        cancelAtPeriodEnd: false,
        periodEnd: "2026-05-09T00:00:00.000Z",
      },
    }));

    await expect(
      new BillingClient(createHttpClient(request)).readBillingStatus(
        "https://api.synch.test/",
        "session-token",
      ),
    ).resolves.toEqual({
      planId: "starter",
      billingInterval: "monthly",
      active: true,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: "2026-05-09T00:00:00.000Z",
    });

    expect(request).toHaveBeenCalledWith({
      url: "https://api.synch.test/v1/billing/status",
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer session-token",
      },
    });
  });

  it("rejects invalid billing status responses", () => {
    expect(() => parseBillingStatus({
      planId: "starter",
      billingInterval: "weekly",
      active: true,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: null,
    })).toThrow("invalid billing status response");
  });
});
