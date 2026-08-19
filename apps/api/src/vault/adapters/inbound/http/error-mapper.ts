import {
	VaultApplicationError,
	type VaultApplicationErrorCode,
} from "../../../application/errors/vault-errors";

export function mapVaultApplicationError(error: unknown): Response | undefined {
	if (!(error instanceof VaultApplicationError) && !isVaultApplicationErrorLike(error)) {
		return undefined;
	}

	const vaultError = error as VaultApplicationError;
	const message = vaultErrorMessage(vaultError.code, vaultError.details);
	const status = vaultErrorStatus(vaultError.code);
	return new Response(
		JSON.stringify({ error: vaultError.code, message }, null, 2),
		{
			status,
			headers: { "content-type": "application/json; charset=utf-8" },
		},
	);
}

function isVaultApplicationErrorLike(
	error: unknown,
): error is VaultApplicationError {
	return (
		!!error &&
		typeof error === "object" &&
		(error as { name?: unknown }).name === "VaultApplicationError" &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

function vaultErrorStatus(code: VaultApplicationErrorCode): 400 | 403 | 404 | 409 {
	switch (code) {
		case "organization_required":
		case "not_organization_member":
			return 400;
		case "vault_limit_exceeded":
		case "forbidden":
			return 403;
		case "not_found":
			return 404;
		case "vault_name_exists":
			return 409;
	}
}

function vaultErrorMessage(
	code: VaultApplicationErrorCode,
	details: Record<string, unknown>,
): string {
	switch (code) {
		case "organization_required":
			return "user has no organization";
		case "vault_limit_exceeded":
			return `${String(details.planName)} allows ${String(details.limit)} synced vault`;
		case "vault_name_exists":
			return "a vault with this name already exists in the organization";
		case "forbidden":
			return "vault access denied";
		case "not_found":
			return "vault not found";
		case "not_organization_member":
			return "user is not a member of the organization";
	}
}
