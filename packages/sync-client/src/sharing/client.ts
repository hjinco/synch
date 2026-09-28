import type {
  KeyTransferEnvelope,
  RemoteVaultKeyEnvelope,
} from "@synch/vault-crypto";
import {
  ApiRequestError,
  createApiRequestError,
  stripTrailingSlash,
  type HttpClient,
} from "../http/request";

export type SharingRole = "owner" | "admin" | "member";
export interface SharingOrganizationSummary {
  id: string;
  name: string;
  role: SharingRole;
}

/** Only the collection endpoint can establish that a server predates sharing. */
export class OrganizationApiUnavailableError extends Error {
  constructor() {
    super("This server does not support organization sharing.");
    this.name = "OrganizationApiUnavailableError";
  }
}
export interface SharingVault {
  id: string;
  name: string;
  shared: boolean;
  personal: boolean;
  canManage: boolean;
  status: "active" | "pending_key" | "revoked" | null;
  members: {
    userId: string;
    name: string;
    email: string;
    canManage: boolean;
    status: string;
  }[];
}
export interface SharingOrganization {
  id: string;
  name: string;
  role: SharingRole;
  sharing: { enabled: boolean; memberLimit: number };
  vaults: SharingVault[];
}
export interface VaultKeyRequest {
  id: string;
  vaultId: string;
  userId: string;
  accessVersion: number;
  publicKey: string;
  purpose: "enrollment" | "recovery";
  status: "pending" | "approved" | "completed" | "canceled";
  envelopeJson: string | null;
  approvedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Captures one authenticated account and server for the lifetime of a key transfer. */
export class SharingClient {
  readonly apiBaseUrl: string;
  constructor(
    private readonly http: HttpClient,
    apiBaseUrl: string,
    private readonly token: string,
  ) {
    this.apiBaseUrl = stripTrailingSlash(apiBaseUrl);
  }
  async organizationSummaries(): Promise<SharingOrganizationSummary[]> {
    try {
      return (await this.request<{ organizations: SharingOrganizationSummary[] }>(
        "/v1/organizations",
      )).organizations;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        throw new OrganizationApiUnavailableError();
      }
      throw error;
    }
  }

  async organizations(): Promise<SharingOrganization[]> {
    const organizations = await this.organizationSummaries();
    return Promise.all(
      organizations.map((org) =>
        this.request<SharingOrganization>(
          `/v1/organizations/${encodeURIComponent(org.id)}`,
        ),
      ),
    );
  }
  async requests(vaultId: string): Promise<VaultKeyRequest[]> {
    return (
      await this.request<{ requests: VaultKeyRequest[] }>(this.path(vaultId))
    ).requests;
  }
  getRequest(vaultId: string, id: string): Promise<VaultKeyRequest> {
    return this.request(`${this.path(vaultId)}/${encodeURIComponent(id)}`);
  }
  start(
    vaultId: string,
    id: string,
    publicKey: string,
  ): Promise<VaultKeyRequest> {
    return this.request(this.path(vaultId), "POST", { id, publicKey });
  }
  async approve(
    request: VaultKeyRequest,
    envelope: KeyTransferEnvelope,
  ): Promise<void> {
    await this.request(
      `${this.path(request.vaultId)}/${encodeURIComponent(request.id)}/approve`,
      "POST",
      { envelope },
    );
  }
  async complete(
    request: VaultKeyRequest,
    envelope: RemoteVaultKeyEnvelope,
  ): Promise<void> {
    await this.request(
      `${this.path(request.vaultId)}/${encodeURIComponent(request.id)}/complete`,
      "POST",
      { envelope },
    );
  }
  async changePassword(
    vaultId: string,
    envelope: RemoteVaultKeyEnvelope,
  ): Promise<void> {
    await this.request(
      `/v1/vaults/${encodeURIComponent(vaultId)}/password-wrapper`,
      "PUT",
      { envelope },
    );
  }
  private path(vaultId: string) {
    return `/v1/vaults/${encodeURIComponent(vaultId)}/key-requests`;
  }
  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.http.request({
      url: `${this.apiBaseUrl}${path}`,
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300)
      throw createApiRequestError(response, "Sharing request failed");
    return response.json as T;
  }
}
