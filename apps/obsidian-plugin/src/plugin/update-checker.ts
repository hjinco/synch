import { defaultHttpClient, type HttpClient } from "../http/request";
import type { SynchCommunityPluginUpdateStatus } from "./view-models";

export const SYNCH_PLUGIN_COMMUNITY_RELEASE_FEED_URL =
  "https://community.obsidian.md/plugins/synch/feed.xml";

const COMMUNITY_RELEASE_GUID_PATTERN =
  /release:plugin:synch:(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;

export class SynchPluginUpdateChecker {
  constructor(private readonly httpClient: HttpClient = defaultHttpClient) {}

  async check(currentVersion: string): Promise<SynchCommunityPluginUpdateStatus> {
    const current = parseStrictSemver(currentVersion);
    if (!current) {
      throw new Error(`Invalid current plugin version: ${currentVersion}`);
    }

    const response = await this.httpClient.request({
      url: SYNCH_PLUGIN_COMMUNITY_RELEASE_FEED_URL,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Community plugin release feed request failed with status ${response.status}.`,
      );
    }

    const feedText = typeof response.text === "string" ? response.text : "";
    const latestRelease = parseLatestCommunityRelease(feedText);
    if (!latestRelease) {
      throw new Error("Community plugin release feed does not contain a version.");
    }

    return compareSemver(latestRelease.parts, current) > 0
      ? {
          state: "update_available",
          currentVersion,
          latestVersion: latestRelease.version,
        }
      : {
          state: "up_to_date",
          currentVersion,
          latestVersion: latestRelease.version,
        };
  }
}

function parseLatestCommunityRelease(
  feedText: string,
): { version: string; parts: [number, number, number] } | null {
  const match = COMMUNITY_RELEASE_GUID_PATTERN.exec(feedText);
  if (!match) {
    return null;
  }

  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return {
    version: `${parts[0]}.${parts[1]}.${parts[2]}`,
    parts,
  };
}

function parseStrictSemver(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
