import { syncAccessPublicError } from "../../../application/errors/sync-access-errors";

export function mapSyncAccessApplicationError(error: unknown): Response | undefined {
	const mapped = syncAccessPublicError(error);
	if (!mapped) {
		return undefined;
	}

	return new Response(
		JSON.stringify({ error: mapped.code, message: mapped.message }, null, 2),
		{
			status: mapped.status,
			headers: { "content-type": "application/json; charset=utf-8" },
		},
	);
}
