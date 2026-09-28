import { describe, expect, it } from "vitest";

import {
	canAccessVault,
	canGrantVaultAccess,
	canManageVault,
	type VaultAuthorizationFacts,
} from "./policy";

const activeMember: VaultAuthorizationFacts = {
	vault: { organizationId: "org-1", deleted: false },
	vaultMembership: { status: "active" },
	organizationRole: "member",
};

describe("vault authorization policy", () => {
	it("allows an active organization member with a vault grant to access", () => {
		expect(canAccessVault(activeMember)).toBe(true);
		expect(canManageVault(activeMember)).toBe(false);
		expect(canGrantVaultAccess(activeMember)).toBe(false);
	});

	it("allows organization owners and admins to manage and grant access", () => {
		for (const role of ["owner", "admin"]) {
			const facts = {
				...activeMember,
				organizationRole: role,
				vaultMembership: null,
			} satisfies VaultAuthorizationFacts;

			expect(canManageVault(facts)).toBe(true);
			expect(canGrantVaultAccess(facts)).toBe(true);
		}
	});

	it("allows an organization owner to grant access without a vault grant", () => {
		const facts = {
			...activeMember,
			vaultMembership: null,
			organizationRole: "owner",
		} satisfies VaultAuthorizationFacts;

		expect(canAccessVault(facts)).toBe(false);
		expect(canManageVault(facts)).toBe(true);
		expect(canGrantVaultAccess(facts)).toBe(true);
	});

	it("denies access and management for a deleted vault", () => {
		const facts = {
			...activeMember,
			vault: { organizationId: "org-1", deleted: true },
			vaultMembership: { status: "active" },
			organizationRole: "owner",
		} satisfies VaultAuthorizationFacts;

		expect(canAccessVault(facts)).toBe(false);
		expect(canManageVault(facts)).toBe(false);
		expect(canGrantVaultAccess(facts)).toBe(false);
	});
});
