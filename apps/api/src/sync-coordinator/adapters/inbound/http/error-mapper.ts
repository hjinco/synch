import { syncAccessPublicError } from "../../../../sync-access/application";
import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";

const DOMAIN_STATUS: Record<string, 409 | 413> = {
	sync_state_uninitialized: 409,
	file_too_large: 413,
	quota_exceeded: 413,
	blob_already_live: 409,
	blob_size_changed: 409,
};

export function mapSyncCoordinatorApplicationError(error: unknown): Response | undefined {
	const syncAccess = syncAccessPublicError(error);
	if (syncAccess) {
		return response({ error: syncAccess.code, message: syncAccess.message }, syncAccess.status);
	}
	if (!(error instanceof SyncCoordinatorApplicationError)) return undefined;
	if (error.code === "sync_paused") {
		return response(
			{ error: "forbidden", message: "vault sync is temporarily paused for repair" },
			403,
		);
	}
	if (error.code === "not_found") {
		return response({ error: "not_found", message: messageOf(error, "not found") }, 404);
	}
	const status = DOMAIN_STATUS[error.code];
	if (status) {
		return response(
			{
				error: domainPublicCode(error.code),
				reason: error.code,
				message: messageOf(error, "request failed"),
			},
			status,
		);
	}
	if (error.code === "stale_revision" || error.code === "version_mismatch") {
		return response(
			{ error: error.code, message: conflictErrorMessage(error) },
			409,
		);
	}
	return response({ error: error.code, message: messageOf(error, "request failed") }, 409);
}

function domainPublicCode(code: string): string {
	switch (code) {
		case "blob_already_live":
		case "blob_size_changed":
			return "conflict";
		default:
			return code;
	}
}

function conflictErrorMessage(error: SyncCoordinatorApplicationError): string {
	if (error.code === "stale_revision") {
		return `expected base revision ${String(error.details.expectedBaseRevision)} but received ${String(error.details.receivedBaseRevision)}`;
	}
	return messageOf(error, "restore payload does not match the requested version");
}

function messageOf(error: SyncCoordinatorApplicationError, fallback: string): string {
	return typeof error.details.message === "string" ? error.details.message : fallback;
}

function response(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
