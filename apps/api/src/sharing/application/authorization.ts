import type { SharingStore } from "./store";
import type { SubscriptionPolicyReader } from "../../subscription/application";
import { organizationSharingPolicy } from "../../subscription/domain/policy";
import { SharingError } from "./types";
import { vaultEnrollmentStatus } from "../../vault/domain/policy";
import { isOrganizationManager } from "../domain/policy";

/** Management and key setup may admit pending enrollment; sync access may not. */
export class SharingAuthorization {
	constructor(
		private readonly store: SharingStore,
		private readonly policy: SubscriptionPolicyReader,
	) {}

	async requireOrganization(
		userId: string,
		organizationId: string,
		manage = false,
	) {
		const member = await this.store.membership(organizationId, userId);
		if (!member || (manage && !isOrganizationManager(member.role))) forbidden();
		return member;
	}

	async requireVault(
		userId: string,
		vaultId: string,
		manage = false,
		pending = false,
	) {
		const vault = await this.store.vault(vaultId);
		if (!vault) throw new SharingError(404, "not_found", "Vault not found");
		const member = await this.requireOrganization(
			userId,
			vault.organizationId,
			manage,
		);
		const storedGrant = await this.store.grant(vaultId, userId);
		const grant = {
			userId,
			isCreator: storedGrant?.isCreator ?? false,
			status: vaultEnrollmentStatus(storedGrant),
			accessVersion: storedGrant?.accessVersion ?? 0,
		};
		if (grant.status !== "active" && !(pending && grant.status === "pending_key")) {
			forbidden();
		}
		return { vault, grant, member };
	}

	async requireSharing(organizationId: string) {
		const plan = await this.policy.readOrganizationPolicy(organizationId);
		const sharing = organizationSharingPolicy(plan.id);
		if (!sharing.enabled)
			throw new SharingError(
				403,
				"sharing_unavailable",
				"Organization sharing requires Sync Plus",
			);
		return sharing;
	}
}

export function forbidden(): never {
	throw new SharingError(
		403,
		"forbidden",
		"You do not have permission for this operation",
	);
}
