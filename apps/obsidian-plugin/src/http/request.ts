import { requestUrl } from "obsidian";

import type {
  HttpClient,
  HttpRequestInput,
  HttpResponseLike,
} from "@synch/sync-client/http/request";

export {
  ApiRequestError,
  createApiRequestError,
  extractErrorCode,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
  type HttpRequestInput,
  type HttpResponseLike,
} from "@synch/sync-client/http/request";

export class ObsidianHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    return (await requestUrl({
      url: input.url,
      method: input.method ?? "GET",
      throw: false,
      headers: input.headers,
      body: input.body,
    }));
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();
