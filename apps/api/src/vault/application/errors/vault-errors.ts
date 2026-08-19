export type VaultApplicationErrorCode =
	| "organization_required"
	| "vault_limit_exceeded"
	| "vault_name_exists"
	| "forbidden"
	| "not_found"
	| "not_organization_member";

export class VaultApplicationError extends Error {
	readonly name = "VaultApplicationError";

	constructor(
		readonly code: VaultApplicationErrorCode,
		readonly details: Record<string, unknown> = {},
	) {
		super(code);
	}
}
