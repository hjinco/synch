import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../adapters/http";
import { SynchServerPluginVersionChecker } from "./server-version-checker";

describe("SynchServerPluginVersionChecker", () => {
  it("checks the configured server with the current plugin version", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        status: "update_required",
        minVersion: "1.2.0",
        apiMajor: 1,
        message: "Update required.",
      },
    }));
    const checker = new SynchServerPluginVersionChecker({
      request,
    } satisfies HttpClient);

    await expect(checker.check("https://api.synch.test/", "1.1.0")).resolves.toEqual({
      status: "update_required",
      minVersion: "1.2.0",
      apiMajor: 1,
      message: "Update required.",
    });
    expect(request).toHaveBeenCalledWith({
      url: "https://api.synch.test/v1/obsidian-plugin/version-check?version=1.1.0",
    });
  });

  it("fails on non-2xx and invalid responses", async () => {
    await expect(
      new SynchServerPluginVersionChecker({
        request: vi.fn(async () => ({
          status: 500,
          json: {},
        })),
      }).check("https://api.synch.test", "1.1.0"),
    ).rejects.toThrow();

    await expect(
      new SynchServerPluginVersionChecker({
        request: vi.fn(async () => ({
          status: 200,
          json: { status: "update_required" },
        })),
      }).check("https://api.synch.test", "1.1.0"),
    ).rejects.toThrow();
  });
});
