import type { SyncTokenResponse } from "./client";
import { SyncAccessClient } from "./client";

const REFRESH_SKEW_SECONDS = 15;
const SUPPORTED_SYNC_FORMAT_VERSIONS = new Set([1, 2]);

export interface SyncTokenManagerDeps {
  getApiBaseUrl: () => string;
  getAuthSessionToken: () => string;
  getRemoteVaultId: () => string | null;
  getLocalVaultId: () => Promise<string>;
  syncAccessClient: SyncAccessClientLike;
  now?: () => number;
}

export type SyncAccessClientLike = Pick<SyncAccessClient, "issueSyncToken">;

export class SyncTokenManager {
  private cachedToken: SyncTokenResponse | null = null;

  constructor(private readonly deps: SyncTokenManagerDeps) {}

  async getTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    const sessionToken = this.deps.getAuthSessionToken().trim();
    if (!sessionToken) {
      throw new Error("Sign in before requesting a sync token.");
    }

    const vaultId = this.deps.getRemoteVaultId()?.trim() ?? "";
    if (!vaultId) {
      throw new Error("Connect a vault before requesting a sync token.");
    }

    const localVaultId = (await this.deps.getLocalVaultId()).trim();
    if (!localVaultId) {
      throw new Error("Local vault ID is not available.");
    }

    if (this.cachedToken && this.canReuseToken(this.cachedToken, vaultId, localVaultId)) {
      return this.cachedToken;
    }

    const issued = await this.deps.syncAccessClient.issueSyncToken(
      this.deps.getApiBaseUrl(),
      sessionToken,
      {
        vaultId,
        localVaultId,
      },
    );
    assertSupportedSyncFormatVersion(issued.syncFormatVersion);

    this.cachedToken = issued;
    return issued;
  }

  clear(): void {
    this.cachedToken = null;
  }

  private canReuseToken(
    token: SyncTokenResponse,
    vaultId: string,
    localVaultId: string,
  ): boolean {
    return (
      token.vaultId === vaultId &&
      token.localVaultId === localVaultId &&
      token.expiresAt > this.nowSeconds() + REFRESH_SKEW_SECONDS
    );
  }

  private nowSeconds(): number {
    const now = this.deps.now ?? Date.now;
    return Math.floor(now() / 1000);
  }
}

function assertSupportedSyncFormatVersion(syncFormatVersion: number): void {
  if (!SUPPORTED_SYNC_FORMAT_VERSIONS.has(syncFormatVersion)) {
    throw new Error(`Unsupported sync format version: ${syncFormatVersion}.`);
  }
}
