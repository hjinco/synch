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

/** Stable public error body for any inbound adapter that surfaces these failures. */
export type SyncAccessPublicError = {
	status: 401 | 403;
	code: "unauthorized" | "forbidden";
	message: string;
};

export const SYNC_ACCESS_PUBLIC_ERROR = {
	missing_token: { status: 401, code: "unauthorized", message: "missing sync token" },
	invalid_token: { status: 401, code: "unauthorized", message: "invalid sync token" },
	expired_token: { status: 401, code: "unauthorized", message: "sync token expired" },
	invalid_token_claims: {
		status: 401,
		code: "unauthorized",
		message: "invalid sync token claims",
	},
	invalid_scope: { status: 403, code: "forbidden", message: "invalid sync scope" },
	vault_mismatch: { status: 403, code: "forbidden", message: "vault mismatch" },
	vault_access_denied: {
		status: 403,
		code: "forbidden",
		message: "vault access denied",
	},
	sync_paused: {
		status: 403,
		code: "forbidden",
		message: "vault sync is temporarily paused for repair",
	},
} as const satisfies Record<SyncAccessApplicationErrorCode, SyncAccessPublicError>;

export function syncAccessPublicError(error: unknown): SyncAccessPublicError | undefined {
	if (!(error instanceof SyncAccessApplicationError)) {
		return undefined;
	}
	return SYNC_ACCESS_PUBLIC_ERROR[error.code];
}
