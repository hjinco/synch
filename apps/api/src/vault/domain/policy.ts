export type VaultAuthorizationFacts = {
	vault: {
		organizationId: string;
		deleted: boolean;
	} | null;
	vaultMembership: {
		role: string;
		status: string;
	} | null;
	organizationRole: string | null;
};

export function canAccessVault(facts: VaultAuthorizationFacts): boolean {
	return (
		facts.vault !== null &&
		!facts.vault.deleted &&
		facts.vaultMembership?.status === "active" &&
		facts.organizationRole !== null
	);
}

export function canManageVault(facts: VaultAuthorizationFacts): boolean {
	return (
		canAccessVault(facts) &&
		(facts.vaultMembership?.role === "owner" ||
			facts.vaultMembership?.role === "admin")
	);
}

export function canGrantVaultAccess(facts: VaultAuthorizationFacts): boolean {
	return (
		canManageVault(facts) ||
		(facts.vault !== null &&
			!facts.vault.deleted &&
			facts.organizationRole === "owner")
	);
}

/** Free remote vaults are deleted after 90 days without a synced change. */
export const FREE_VAULT_INACTIVITY_DELETE_AFTER_MS =
	90 * 24 * 60 * 60 * 1000;

export const FREE_VAULT_INACTIVITY_DELETE_DAYS = Math.round(
	FREE_VAULT_INACTIVITY_DELETE_AFTER_MS / (24 * 60 * 60 * 1000),
);

/**
 * Only free-plan organizations are subject to inactivity-based vault
 * deletion. Kept as a string predicate so the vault domain does not need to
 * depend on the subscription domain.
 */
export function isInactivityDeletionPlan(planId: string): boolean {
	return planId === "free";
}
