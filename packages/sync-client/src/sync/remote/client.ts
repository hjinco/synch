import {
  createApiRequestError,
  stripTrailingSlash,
  type HttpClient,
} from "../../http/request";
import { remoteVaultUnavailableFromApiError } from "../../remote-vault/unavailable";

export interface SyncTokenResponse {
  token: string;
  expiresAt: number;
  vaultId: string;
  localVaultId: string;
}

export class SyncAccessClient {
  constructor(private readonly httpClient: HttpClient) {}

  async issueSyncToken(
    apiBaseUrl: string,
    sessionToken: string,
    input: { vaultId: string; localVaultId: string },
  ): Promise<SyncTokenResponse> {
    try {
      return await this.requestJson<SyncTokenResponse>(
        `${stripTrailingSlash(apiBaseUrl)}/v1/sync/token`,
        sessionToken,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    } catch (error) {
      throw remoteVaultUnavailableFromApiError(error, input.vaultId) ?? error;
    }
  }

  private async requestJson<T>(
    url: string,
    sessionToken: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await this.httpClient.request({
      url,
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        ...(init.body
          ? {
              "content-type": "application/json",
            }
          : {}),
      },
      body: init.body,
    });

    if (response.status < 200 || response.status >= 300) {
      throw createApiRequestError(
        response,
        `sync access request failed with status ${response.status}`,
      );
    }

    return response.json as T;
  }
}
