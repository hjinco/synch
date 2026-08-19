import { BlobTransferApplicationError } from "../../../application/errors/blob-transfer-errors";

type CoordinatorStageRejection = {
	status: 400 | 401 | 403 | 404 | 409 | 413;
	code: string;
	includeReason?: true;
};

const COORDINATOR_STAGE_REJECTION: Record<string, CoordinatorStageRejection> = {
	sync_state_uninitialized: {
		status: 409,
		code: "sync_state_uninitialized",
		includeReason: true,
	},
	file_too_large: { status: 413, code: "file_too_large", includeReason: true },
	quota_exceeded: { status: 413, code: "quota_exceeded", includeReason: true },
	blob_already_live: { status: 409, code: "conflict", includeReason: true },
	blob_size_changed: { status: 409, code: "conflict", includeReason: true },
	bad_request: { status: 400, code: "bad_request" },
	unauthorized: { status: 401, code: "unauthorized" },
	forbidden: { status: 403, code: "forbidden" },
	not_found: { status: 404, code: "not_found" },
};

export function mapBlobTransferApplicationError(error: unknown): Response | undefined {
	if (!(error instanceof BlobTransferApplicationError)) {
		return undefined;
	}
	if (error.code === "size_mismatch") {
		const declared = error.details?.declaredSizeBytes;
		return jsonResponse(
			{
				error: "size_mismatch",
				message: `declared blob size ${String(declared)} did not match the uploaded body`,
			},
			400,
		);
	}
	if (error.code === "invalid_id") {
		return jsonResponse({ error: "bad_request", message: "invalid blob identifier" }, 400);
	}

	const reason = stageRejectionKey(error.details);
	const mapping = COORDINATOR_STAGE_REJECTION[reason];
	if (!mapping) {
		return jsonResponse({ error: "internal_error", message: "unexpected server error" }, 500);
	}
	const message =
		typeof error.details?.message === "string"
			? error.details.message
			: "blob staging was rejected";
	return jsonResponse(
		mapping.includeReason
			? { error: mapping.code, reason, message }
			: { error: mapping.code, message },
		mapping.status,
	);
}

function stageRejectionKey(details: Record<string, unknown> | undefined): string {
	if (typeof details?.reason === "string" && details.reason in COORDINATOR_STAGE_REJECTION) {
		return details.reason;
	}
	if (typeof details?.error === "string" && details.error in COORDINATOR_STAGE_REJECTION) {
		return details.error;
	}
	return typeof details?.reason === "string" ? details.reason : "";
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
