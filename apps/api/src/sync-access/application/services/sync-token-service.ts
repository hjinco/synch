import { LEGACY_PAUSE_QUOTA_COMPATIBILITY } from "../../domain/legacy-pause-compatibility";
import type { VaultService } from "../../../vault/application";
import { DEFAULT_SYNC_TOKEN_TTL_SECONDS } from "../../domain/token-policy";
import { SyncAccessApplicationError } from "../errors/sync-access-errors";
import type { IssueSyncToken } from "../ports/inbound/issue-sync-token";
import type { VerifySyncToken } from "../ports/inbound/verify-sync-token";
import type { SyncPauseResumer } from "../ports/outbound/sync-pause-resumer";
import type { SyncPauseReader } from "../ports/outbound/sync-pause-reader";
import type { SyncTokenCodec } from "../ports/outbound/sync-token-codec";
import type {
	SyncTokenClaims,
	SyncTokenIssueInput,
	SyncTokenIssueResponse,
} from "../dto/token";

// TODO: Remove this field after MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION is
// raised past plugin releases that still validate syncFormatVersion.
const CURRENT_SYNC_FORMAT_VERSION = 2;

export class IssueSyncTokenService implements IssueSyncToken {
	private readonly syncTokenTtlSeconds: number;

	constructor(
		private readonly vaultService: VaultService,
		private readonly syncTokenCodec: Pick<SyncTokenCodec, "signSyncToken">,
		private readonly syncPauseReader: SyncPauseReader,
		syncTokenTtlSeconds = DEFAULT_SYNC_TOKEN_TTL_SECONDS,
		private readonly accessReader?: (userId: string, vaultId: string) => Promise<number>,
		private readonly syncPauseResumer?: SyncPauseResumer,
	) {
		this.syncTokenTtlSeconds = syncTokenTtlSeconds;
	}

	async issueSyncToken(input: SyncTokenIssueInput): Promise<SyncTokenIssueResponse> {
		const vault = await this.vaultService.getAccessibleVault(input.userId, input.vaultId);
		if (!vault) {
			throw new SyncAccessApplicationError("vault_access_denied");
		}

		// Verify live membership/subscription access before changing vault state.
		const accessVersion = await this.accessReader?.(input.userId, input.vaultId);
		let syncPause = await this.syncPauseReader.readSyncPause(vault.id);
		if (input.resumeSync && syncPause) {
			if (!this.syncPauseResumer) throw new SyncAccessApplicationError("sync_paused");
			await this.syncPauseResumer.resumeSync(vault.id);
			syncPause = await this.syncPauseReader.readSyncPause(vault.id);
			if (syncPause) throw new SyncAccessApplicationError("sync_paused");
		}
		if (syncPause && !LEGACY_PAUSE_QUOTA_COMPATIBILITY) {
			throw new SyncAccessApplicationError("sync_paused");
		}

		const now = Math.floor(Date.now() / 1000);
		const claims = {
			...(accessVersion === undefined ? {} : { accessVersion }),
			sub: input.userId,
			vaultId: input.vaultId,
			localVaultId: input.localVaultId,
			displayName: input.displayName.trim(),
			scope: "vault:sync" as const,
			iat: now,
			exp: now + this.syncTokenTtlSeconds,
		};
		const token = await this.syncTokenCodec.signSyncToken(claims);

		return {
			token,
			expiresAt: claims.exp,
			vaultId: claims.vaultId,
			localVaultId: claims.localVaultId,
			syncFormatVersion: CURRENT_SYNC_FORMAT_VERSION,
		};
	}
}

export class VerifySyncTokenService implements VerifySyncToken {
	constructor(private readonly syncTokenCodec: Pick<SyncTokenCodec, "verifySyncToken">, private readonly accessVerifier?: (claims: SyncTokenClaims, token: string) => Promise<unknown>) {}

	async verifySyncToken(
		token: string | null | undefined,
		expectedVaultId?: string,
	): Promise<SyncTokenClaims> {
		if (!token) {
			throw new SyncAccessApplicationError("missing_token");
		}

		const claims = await this.syncTokenCodec.verifySyncToken(token);
		if (claims.scope !== "vault:sync") {
			throw new SyncAccessApplicationError("invalid_scope");
		}
		if (expectedVaultId && claims.vaultId !== expectedVaultId) {
			throw new SyncAccessApplicationError("vault_mismatch");
		}
		await this.accessVerifier?.(claims, token);
		return claims;
	}
}
