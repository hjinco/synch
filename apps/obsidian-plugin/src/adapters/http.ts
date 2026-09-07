import { requestUrl } from "obsidian";

import type {
  HttpClient,
  HttpRequestInput,
  HttpResponseLike,
} from "@synch/sync-client/http";

export {
  ApiRequestError,
  createApiRequestError,
  extractErrorCode,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
  type HttpRequestInput,
  type HttpResponseLike,
} from "@synch/sync-client/http";

export class ObsidianHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    const response = await requestUrl({
      url: input.url,
      method: input.method ?? "GET",
      throw: false,
      headers: input.headers,
      body: input.body,
    });
    return {
      status: response.status,
      get arrayBuffer() { return response.arrayBuffer; },
      get text() { return response.text; },
      get json(): unknown {
        // Obsidian parses lazily and throws even when requestUrl uses throw:false.
        // Keep non-JSON error bodies from hiding the HTTP status. Successful JSON
        // responses remain strict, and binary responses are never eagerly parsed.
        if (response.status >= 200 && response.status < 300) return response.json as unknown;
        try { return response.json as unknown; } catch { return undefined; }
      },
    };
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();
