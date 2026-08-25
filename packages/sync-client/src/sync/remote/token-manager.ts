import type { SyncTokenResponse } from "./client";
import { SyncAccessClient } from "./client";

const REFRESH_SKEW_SECONDS = 15;

export interface SyncTokenManagerDeps {
  getApiBaseUrl: () => string;
  getAuthSessionToken: () => string;
  getRemoteVaultId: () => string | null;
  getLocalVaultId: () => Promise<string>;
  syncAccessClient: SyncAccessClientLike;
  now?: () => number;
}

export type SyncAccessClientLike = Pick<SyncAccessClient, "issueSyncToken">;

export type SyncTokenErrorCode =
  | "not_signed_in"
  | "no_active_vault"
  | "missing_local_vault_id";

export class SyncTokenError extends Error {
  constructor(
    readonly code: SyncTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncTokenError";
  }
}

export class SyncTokenManager {
  private cachedToken: SyncTokenResponse | null = null;

  constructor(private readonly deps: SyncTokenManagerDeps) {}

  async getTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    const sessionToken = this.deps.getAuthSessionToken().trim();
    if (!sessionToken) {
      throw new SyncTokenError(
        "not_signed_in",
        "Sign in before requesting a sync token.",
      );
    }

    const vaultId = this.deps.getRemoteVaultId()?.trim() ?? "";
    if (!vaultId) {
      throw new SyncTokenError(
        "no_active_vault",
        "Connect a vault before requesting a sync token.",
      );
    }

    const localVaultId = (await this.deps.getLocalVaultId()).trim();
    if (!localVaultId) {
      throw new SyncTokenError(
        "missing_local_vault_id",
        "Local vault ID is not available.",
      );
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
