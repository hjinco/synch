import {
  stripTrailingSlash,
  type HttpClient,
  type HttpResponseLike,
} from "../../http/request";
import type { SyncTokenResponse } from "./client";

export interface SyncAuthorizedRequestClientDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  httpClient: HttpClient;
}

export interface SyncAuthorizedRequestInput {
  path: (token: SyncTokenResponse) => string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface SyncAuthorizedRequestResult {
  response: HttpResponseLike;
  token: SyncTokenResponse;
}

export class SyncAuthorizedRequestClient {
  constructor(private readonly deps: SyncAuthorizedRequestClientDeps) {}

  async request(input: SyncAuthorizedRequestInput): Promise<SyncAuthorizedRequestResult> {
    let retrying = false;

    while (true) {
      const token = await this.deps.getSyncToken();
      const response = await this.deps.httpClient.request({
        url: `${stripTrailingSlash(this.deps.getApiBaseUrl())}${input.path(token)}`,
        method: input.method ?? "GET",
        headers: {
          authorization: `Bearer ${token.token}`,
          ...input.headers,
        },
        body: input.body,
      });

      if (response.status !== 401 || retrying) {
        return { response, token };
      }

      retrying = true;
      this.deps.invalidateSyncToken();
    }
  }
}
