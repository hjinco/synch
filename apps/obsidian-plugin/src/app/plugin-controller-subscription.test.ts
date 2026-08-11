import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetObsidianMocks, setRequestUrlMock } from "../test-stubs/obsidian";
import { SynchPluginController } from "./plugin-controller";
import { createConnectedPlugin } from "./__tests__/readiness-helpers";

describe("SynchPluginController subscription status", () => {
  beforeEach(() => {
    resetObsidianMocks();
    vi.restoreAllMocks();
  });

  it("loads billing status for the signed-in account", async () => {
    const plugin = await createConnectedPlugin();
    const request = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      if (url.endsWith("/v1/billing/status")) {
        return {
          status: 200,
          json: {
            planId: "starter",
            billingInterval: "monthly",
            active: true,
            status: "active",
            cancelAtPeriodEnd: false,
            periodEnd: "2026-05-09T00:00:00.000Z",
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });
    await controller.initialize();

    await controller.ensureSubscriptionStatusCheck();

    expect(controller.getSubscriptionStatus()).toEqual({
      state: "loaded",
      planId: "starter",
      billingInterval: "monthly",
      active: true,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: "2026-05-09T00:00:00.000Z",
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:8787/v1/billing/status",
        headers: expect.objectContaining({
          authorization: "Bearer stored-token",
        }),
      }),
    );
  });

  it("stores a failed state for invalid billing status responses", async () => {
    const plugin = await createConnectedPlugin();
    setRequestUrlMock(
      vi.fn(async (input: unknown) => {
        const url = String((input as { url?: string }).url ?? "");
        if (url.endsWith("/api/auth/get-session")) {
          return {
            status: 200,
            json: {
              session: { id: "session-1" },
              user: {
                id: "user-1",
                email: "user@example.com",
                name: "User One",
              },
            },
          };
        }

        if (url.endsWith("/v1/billing/status")) {
          return {
            status: 200,
            json: {
              planId: "starter",
              billingInterval: "weekly",
              active: true,
              status: "active",
              cancelAtPeriodEnd: false,
              periodEnd: null,
            },
          };
        }

        throw new Error(`unexpected request ${url}`);
      }),
    );
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });
    await controller.initialize();

    await controller.ensureSubscriptionStatusCheck();

    expect(controller.getSubscriptionStatus()).toEqual({
      state: "failed",
      error: "invalid billing status response",
    });
  });

  it("skips billing status checks for custom API servers", async () => {
    const plugin = await createConnectedPlugin({
      apiBaseUrl: "https://custom.synch.test",
    });
    const request = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });
    await controller.initialize();

    await controller.ensureSubscriptionStatusCheck();

    expect(controller.getSubscriptionStatus()).toEqual({ state: "idle" });
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://custom.synch.test/v1/billing/status",
      }),
    );
  });
});
