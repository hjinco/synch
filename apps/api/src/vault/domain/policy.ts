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
