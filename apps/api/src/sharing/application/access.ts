import type { SubscriptionPolicyReader } from "../../subscription/application";
import { organizationSharingPolicy } from "../../subscription/domain/policy";
import type { SharingStore } from "./store";
import { SharingError } from "./types";

/** Authoritative D1 checks used when issuing a sync token. */
export class SharingAccess {
	constructor(
		private readonly store: SharingStore,
		private readonly policy: SubscriptionPolicyReader,
	) {}
	async isSuspended(vaultId: string): Promise<boolean> {
		const vault = await this.store.vault(vaultId);
		if (!vault?.sharedAt) return false;
		return !organizationSharingPolicy(
			(await this.policy.readOrganizationPolicy(vault.organizationId)).id,
		).enabled;
	}
	async require(
		userId: string,
		vaultId: string,
	): Promise<number> {
		const vault = await this.store.vault(vaultId);
		const grant = await this.store.grant(vaultId, userId);
		if (
			!vault ||
			!grant ||
			grant.status !== "active" ||
			!(await this.store.membership(vault.organizationId, userId))
		)
			throw new SharingError(
				403,
				"vault_access_denied",
				"Vault access has been removed or is awaiting key setup",
			);
		if (vault.sharedAt && (await this.isSuspended(vaultId)))
			throw new SharingError(
				403,
				"sharing_suspended",
				"Shared vault sync is paused until the organization renews Sync Plus",
			);
		return grant.accessVersion;
	}
}
