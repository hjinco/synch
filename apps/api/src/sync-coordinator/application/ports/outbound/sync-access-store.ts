/** Keys distinguish vault-wide suspension from individual user revocations. */
export type SyncAccessRevocation = {
	key: string;
	/** Null for a vault-wide suspension. */
	minimumVersion: number | null;
	expiresAt: number;
};

export interface SyncAccessStore {
	readRevocations(): SyncAccessRevocation[];
	writeRevocation(revocation: SyncAccessRevocation): void;
	deleteRevocation(key: string): void;
	prune(now: number): void;
}
