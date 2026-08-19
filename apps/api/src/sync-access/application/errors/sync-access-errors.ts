export type SyncAccessApplicationErrorCode =
	| "missing_token"
	| "invalid_token"
	| "expired_token"
	| "invalid_token_claims"
	| "invalid_scope"
	| "vault_mismatch"
	| "vault_access_denied"
	| "sync_paused";

export class SyncAccessApplicationError extends Error {
	readonly name = "SyncAccessApplicationError";

	constructor(
		readonly code: SyncAccessApplicationErrorCode,
		readonly details?: Record<string, unknown>,
	) {
		super(code);
	}
}
