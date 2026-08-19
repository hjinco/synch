export type BlobTransferApplicationErrorCode =
	| "invalid_id"
	| "size_mismatch"
	| "coordinator_stage_rejected";

export class BlobTransferApplicationError extends Error {
	readonly name = "BlobTransferApplicationError";

	constructor(
		readonly code: BlobTransferApplicationErrorCode,
		readonly details?: Record<string, unknown>,
	) {
		super(code);
	}
}
