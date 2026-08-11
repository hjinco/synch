import {
  defaultHttpClient,
  stripTrailingSlash,
  type HttpClient,
} from "../adapters/http";

export const SUPPORTED_SYNCH_API_MAJOR = 1;

export type ServerPluginVersionStatus =
  | {
      status: "ok";
      minVersion: string;
      apiMajor: number;
    }
  | {
      status: "update_required";
      minVersion: string;
      apiMajor: number;
      message: string;
    };

export class SynchServerPluginVersionChecker {
  constructor(private readonly httpClient: HttpClient = defaultHttpClient) {}

  async check(apiBaseUrl: string, currentVersion: string): Promise<ServerPluginVersionStatus> {
    const response = await this.httpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/v1/obsidian-plugin/version-check?version=${encodeURIComponent(currentVersion)}`,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Server plugin version check failed with status ${response.status}.`);
    }

    const body = response.json;
    const status = parseServerPluginVersionStatus(body);
    if (!status) {
      throw new Error("Server plugin version check returned an invalid response.");
    }

    return status;
  }
}

function parseServerPluginVersionStatus(value: unknown): ServerPluginVersionStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    typeof record.minVersion !== "string"
  ) {
    return null;
  }

  const apiMajor = parseApiMajor(record.apiMajor);
  if (apiMajor === null) {
    return null;
  }

  if (record.status === "ok") {
    return {
      status: "ok",
      minVersion: record.minVersion,
      apiMajor,
    };
  }

  if (record.status === "update_required" && typeof record.message === "string") {
    return {
      status: "update_required",
      minVersion: record.minVersion,
      apiMajor,
      message: record.message,
    };
  }

  return null;
}

function parseApiMajor(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
