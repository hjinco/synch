import {
  createApiRequestError,
  stripTrailingSlash,
  type HttpClient,
} from "../http/request";
import { remoteVaultUnavailableFromApiError } from "./unavailable";
import type {
  CreateRemoteVaultResponse,
  RemoteVaultBootstrapResponse,
  RemoteVaultKeyWrapper,
  RemoteVaultSummaryResponse,
} from "./types";

export class RemoteVaultClient {
  constructor(private readonly httpClient: HttpClient) {}

  async listRemoteVaults(
    apiBaseUrl: string,
    sessionToken: string,
  ): Promise<RemoteVaultSummaryResponse> {
    return await this.requestJson<RemoteVaultSummaryResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/vaults`,
      sessionToken,
    );
  }

  async createRemoteVault(
    apiBaseUrl: string,
    sessionToken: string,
    input: { name: string; initialWrapper: RemoteVaultKeyWrapper },
  ): Promise<CreateRemoteVaultResponse> {
    return await this.requestJson<CreateRemoteVaultResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/vaults`,
      sessionToken,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async getRemoteVaultBootstrap(
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
  ): Promise<RemoteVaultBootstrapResponse> {
    try {
      return await this.requestJson<RemoteVaultBootstrapResponse>(
        `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/bootstrap`,
        sessionToken,
      );
    } catch (error) {
      throw remoteVaultUnavailableFromApiError(error, vaultId) ?? error;
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
        `vault request failed with status ${response.status}`,
      );
    }

    return response.json as T;
  }
}
