import type { SharingStore } from "./store";
import type { SubscriptionPolicyReader } from "../../subscription/application";
import { organizationSharingPolicy } from "../../subscription/domain/policy";
import { isOrganizationManager } from "../domain/policy";
import { forbidden, type SharingAuthorization } from "./authorization";
import { SharingError } from "./types";
import type { SharingRefreshService } from "./refresh";
import { vaultEnrollmentStatus } from "../../vault/domain/policy";

export class OrganizationService {
	constructor(
		private readonly store: SharingStore,
		private readonly policy: SubscriptionPolicyReader,
		private readonly authorization: SharingAuthorization,
		private readonly refreshes: SharingRefreshService,
		private readonly config: { billingBaseURL?: string },
	) {}

	async listOrganizations(userId: string) {
		return Promise.all(
			(await this.store.organizations(userId)).map(async (org) => ({
				...org,
				plan: await this.policy.readOrganizationPolicy(org.id),
			})),
		);
	}

	async organization(userId: string, organizationId: string) {
		const actor = await this.authorization.requireOrganization(
			userId,
			organizationId,
		);
		const [organization, plan, members, vaults] = await Promise.all([
			this.store.organization(organizationId),
			this.policy.readOrganizationPolicy(organizationId),
			this.store.members(organizationId),
			this.store.vaults(organizationId),
		]);
		const manage = isOrganizationManager(actor.role);
		const visibleVaults = [];
		for (const vault of vaults) {
			const grant = await this.store.grant(vault.id, userId);
			const status = vaultEnrollmentStatus(grant);
			const grants = manage ? await this.store.grants(vault.id) : [];
			visibleVaults.push({
				id: vault.id,
				name: vault.name,
				shared: vault.sharedAt !== null,
				personal: grant?.isCreator === true,
				canManage: manage,
				status,
				members: manage
					? members.map((member) => {
						const grant = grants.find((grant) => grant.userId === member.id);
						return {
							userId: member.id,
							name: member.name,
							email: member.email,
							canManage: isOrganizationManager(member.role),
							status: vaultEnrollmentStatus(grant),
						};
					})
					: [],
			});
		}
		await this.refreshes.flush();
		return {
			id: organizationId,
			billingUrl: this.config.billingBaseURL
				? new URL(
						`/billing?organizationId=${encodeURIComponent(organizationId)}`,
						this.config.billingBaseURL,
					).toString()
				: null,
			name: organization!.name,
			role: actor.role,
			plan,
			sharing: organizationSharingPolicy(plan.id),
			members: manage ? members : members.filter((m) => m.id === userId),
			vaults: visibleVaults,
			invitations: manage ? await this.store.invitations(organizationId) : [],
		};
	}

	async rename(userId: string, organizationId: string, name: string) {
		await this.authorization.requireOrganization(userId, organizationId, true);
		await this.store.rename(organizationId, name);
	}

	async changeMember(
		userId: string,
		organizationId: string,
		targetId: string,
		role?: "admin" | "member",
	) {
		const actor = await this.authorization.requireOrganization(userId, organizationId);
		const target = await this.store.membership(organizationId, targetId);
		if (!target) {
			if (!role) return { pending: !(await this.refreshes.flush()) };
			forbidden();
		}
		if (target.role === "owner")
			throw new SharingError(
				409,
				"owner_protected",
				"The organization owner cannot be removed or demoted here",
			);
		if (role) {
			if (actor.role !== "owner") forbidden();
			await this.store.changeOrganizationRole(organizationId, targetId, role);
		} else {
			if (
				userId !== targetId &&
				(!isOrganizationManager(actor.role) ||
					(target.role === "admin" && actor.role !== "owner"))
			)
				forbidden();
			await this.store.removeOrganizationMember(organizationId, targetId);
		}
		await this.store.audit(
			organizationId,
			userId,
			role ? "member_role_changed" : "member_removed",
			targetId,
		);
		return { pending: !(await this.refreshes.flush()) };
	}
}
