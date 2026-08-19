export class SyncCoordinatorApplicationError extends Error {
	readonly name = "SyncCoordinatorApplicationError";

	constructor(
		readonly code: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(code);
	}
}
