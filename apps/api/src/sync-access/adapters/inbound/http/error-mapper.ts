import {
	SyncAccessApplicationError,
	type SyncAccessApplicationErrorCode,
} from "../../../application/errors/sync-access-errors";

const ERROR_RESPONSES: Record<
	SyncAccessApplicationErrorCode,
	{ status: 401 | 403; code: string; message: string }
> = {
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
};

export function mapSyncAccessApplicationError(error: unknown): Response | undefined {
	if (!(error instanceof SyncAccessApplicationError)) {
		return undefined;
	}

	const mapped = ERROR_RESPONSES[error.code];
	return new Response(
		JSON.stringify({ error: mapped.code, message: mapped.message }, null, 2),
		{
			status: mapped.status,
			headers: { "content-type": "application/json; charset=utf-8" },
		},
	);
}
