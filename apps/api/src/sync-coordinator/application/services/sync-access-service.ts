import { SharingError } from "../../../sharing/application/types";
import type { SocketGateway } from "../ports/outbound";
import type {
	SyncAccessStore,
	SyncAccessRevocation,
} from "../ports/outbound/sync-access-store";

/** The API has already verified the token's signature, expiry and vault scope. */
export type VerifiedVaultAccess = {
	vaultId: string;
	userId: string;
	accessVersion: number;
};
export type VaultAccessDecision =
	| { ok: true }
	| { ok: false; status: 403 | 503; code: string; message: string };
export type SyncAccessSnapshot = {
	suspended: boolean;
	grants: { userId: string; accessVersion: number }[];
};

const VAULT_SUSPENSION_KEY = "vault";
const userRevocationKey = (userId: string) => `user:${userId}`;

/** D1 is read only when an access change or subscription webhook reaches this vault. */
export class CoordinatorSyncAccessService {
	private revocations: Map<string, SyncAccessRevocation> | undefined;
	private nextExpiry = Infinity;
	private refreshTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: SyncAccessStore,
		private readonly sockets: SocketGateway,
		private readonly readSnapshot: (vaultId: string) => Promise<SyncAccessSnapshot>,
		private readonly tokenLifetimeMs: number,
	) {}

	/** Synchronous so socket acceptance can recheck without yielding to a revocation. */
	require(input: VerifiedVaultAccess): void {
		this.load();
		const error = this.denial(input.userId, input.accessVersion);
		if (error) throw error;
	}

	authorizeVerified(input: VerifiedVaultAccess): VaultAccessDecision {
		try {
			this.require(input);
			return { ok: true };
		} catch (error) {
			if (error instanceof SharingError) {
				return {
					ok: false,
					status: error.status === 503 ? 503 : 403,
					code: error.code,
					message: error.message,
				};
			}
			return {
				ok: false,
				status: 503,
				code: "access_unavailable",
				message: "Vault access could not be verified",
			};
		}
	}

	refresh(vaultId: string): Promise<void> {
		// Serialize refreshes so a slower, older D1 read cannot undo a newer change.
		const refresh = this.refreshTail.catch(() => {}).then(async () => {
			const snapshot = await this.readSnapshot(vaultId);
			this.load();
			const expiresAt = Date.now() + this.tokenLifetimeMs;
			try {
				for (const grant of snapshot.grants) {
					if (grant.accessVersion <= 1) continue;
					const key = userRevocationKey(grant.userId);
					const previous = this.revocations?.get(key);
					this.store.writeRevocation({
						key,
						minimumVersion: Math.max(grant.accessVersion, previous?.minimumVersion ?? 0),
						expiresAt: Math.max(expiresAt, previous?.expiresAt ?? 0),
					});
				}
				if (snapshot.suspended) {
					this.store.writeRevocation({
						key: VAULT_SUSPENSION_KEY,
						minimumVersion: null,
						expiresAt,
					});
				} else {
					// Renewal clears only the vault-wide block, never a user's revocation.
					this.store.deleteRevocation(VAULT_SUSPENSION_KEY);
				}
			} finally {
				// Reload even after a partial persistence failure; never keep a stale cache.
				this.revocations = undefined;
				this.load();
			}
			this.closeDeniedSockets();
		});
		this.refreshTail = refresh;
		return refresh;
	}

	private load(): void {
		if (!this.revocations) {
			this.revocations = new Map(this.store.readRevocations().map((entry) => [entry.key, entry]));
			this.nextExpiry = this.earliestExpiry();
		}
		const now = Date.now();
		if (this.nextExpiry > now) return;
		// No alarm or polling: expired blocks are discarded on the next access.
		this.store.prune(now);
		for (const [key, entry] of this.revocations) {
			if (entry.expiresAt <= now) this.revocations.delete(key);
		}
		this.nextExpiry = this.earliestExpiry();
	}

	private earliestExpiry(): number {
		return Math.min(...[...(this.revocations?.values() ?? [])].map((entry) => entry.expiresAt));
	}

	private denial(userId: string, version: number): SharingError | null {
		if (this.revocations?.has(VAULT_SUSPENSION_KEY)) {
			return new SharingError(403, "sharing_suspended", "Shared vault sync is paused until the organization renews Sync Plus");
		}
		const revoked = this.revocations?.get(userRevocationKey(userId));
		if (revoked?.minimumVersion != null && version < revoked.minimumVersion) {
			return new SharingError(403, "vault_access_denied", "This sync session is no longer authorized");
		}
		return null;
	}

	private closeDeniedSockets(): void {
		for (const { connectionId, session } of this.sockets.listSocketSessions()) {
			if (this.denial(session.userId, session.accessVersion ?? 1)) {
				this.sockets.closeSocket(connectionId, 1012, "vault access changed; reconnect");
			}
		}
	}
}
