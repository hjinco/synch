import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../platform/http";
import {
  SYNCH_PLUGIN_COMMUNITY_RELEASE_FEED_URL,
  SynchPluginUpdateChecker,
} from "./update-checker";

function communityReleaseFeed(versions: string[]): string {
  const items = versions
    .map((version) => `<guid isPermaLink="false">release:plugin:synch:${version}</guid>`)
    .join("");
  return `<rss><channel>${items}</channel></rss>`;
}

describe("SynchPluginUpdateChecker", () => {
  it("reports an available update from the community release feed", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: communityReleaseFeed(["0.0.2", "0.0.1"]),
    }));
    const checker = new SynchPluginUpdateChecker({ request } satisfies HttpClient);

    await expect(checker.check("0.0.1")).resolves.toEqual({
      state: "update_available",
      currentVersion: "0.0.1",
      latestVersion: "0.0.2",
    });
    expect(request).toHaveBeenCalledWith({
      url: SYNCH_PLUGIN_COMMUNITY_RELEASE_FEED_URL,
    });
  });

  it("reports up to date when the community version is equal or older", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: communityReleaseFeed(["0.0.1"]),
    }));
    const checker = new SynchPluginUpdateChecker({ request } satisfies HttpClient);

    await expect(checker.check("0.0.2")).resolves.toEqual({
      state: "up_to_date",
      currentVersion: "0.0.2",
      latestVersion: "0.0.1",
    });
  });

  it("fails on network errors and non-2xx responses", async () => {
    await expect(
      new SynchPluginUpdateChecker({
        request: vi.fn(async () => {
          throw new Error("offline");
        }),
      }).check("0.0.1"),
    ).rejects.toThrow("offline");

    await expect(
      new SynchPluginUpdateChecker({
        request: vi.fn(async () => ({
          status: 404,
          text: "",
        })),
      }).check("0.0.1"),
    ).rejects.toThrow("Community plugin release feed request failed with status 404.");
  });

  it("fails on malformed feeds and versions", async () => {
    await expect(
      new SynchPluginUpdateChecker({
        request: vi.fn(async () => ({
          status: 200,
          text: "<rss></rss>",
        })),
      }).check("0.0.1"),
    ).rejects.toThrow("Community plugin release feed does not contain a version.");

    await expect(
      new SynchPluginUpdateChecker({
        request: vi.fn(async () => ({
          status: 200,
          text: communityReleaseFeed(["0.0.2"]),
        })),
      }).check("0.0"),
    ).rejects.toThrow("Invalid current plugin version: 0.0");
  });
});
