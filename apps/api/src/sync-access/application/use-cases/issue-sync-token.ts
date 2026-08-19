import type { VaultService } from "../../../vault/application";
import { SyncAccessApplicationError } from "../errors/sync-access-errors";
import type { IssueSyncToken } from "../ports/inbound/issue-sync-token";
import type { SyncPauseReader } from "../ports/outbound/sync-pause-reader";
import type { SyncTokenCodec } from "../ports/outbound/sync-token-codec";
import type {
	SyncTokenIssueInput,
	SyncTokenIssueResponse,
} from "../dto/token";

const DEFAULT_SYNC_TOKEN_TTL_SECONDS = 120;

export class IssueSyncTokenUseCase implements IssueSyncToken {
	private readonly syncTokenTtlSeconds: number;

	constructor(
		private readonly vaultService: VaultService,
		private readonly syncTokenCodec: Pick<SyncTokenCodec, "signSyncToken">,
		private readonly syncPauseReader: SyncPauseReader,
		syncTokenTtlSeconds = DEFAULT_SYNC_TOKEN_TTL_SECONDS,
	) {
		this.syncTokenTtlSeconds = syncTokenTtlSeconds;
	}

	async issueSyncToken(input: SyncTokenIssueInput): Promise<SyncTokenIssueResponse> {
		const vault = await this.vaultService.getAccessibleVault(input.userId, input.vaultId);
		if (!vault) {
			throw new SyncAccessApplicationError("vault_access_denied");
		}

		const syncPause = await this.syncPauseReader.readSyncPause(vault.id);
		if (syncPause) {
			throw new SyncAccessApplicationError("sync_paused");
		}

		const now = Math.floor(Date.now() / 1000);
		const claims = {
			sub: input.userId,
			vaultId: input.vaultId,
			localVaultId: input.localVaultId,
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
			syncFormatVersion: vault.syncFormatVersion,
		};
	}
}
