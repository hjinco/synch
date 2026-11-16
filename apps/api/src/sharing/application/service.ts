import type { SharingStore } from "./store";
import type { SubscriptionPolicyReader } from "../../subscription/application";
import { SharingAuthorization } from "./authorization";
import { InvitationService, type InvitationConfig } from "./invitation-service";
import { KeyRequestService } from "./key-request-service";
import { OrganizationService } from "./organization-service";
import { SharingRefreshService, type SharingInvalidator } from "./refresh";

export type SharingConfig = InvitationConfig & { billingBaseURL?: string };
export type SharingService = ReturnType<typeof createSharingService>;

/** Binds the public use cases without exposing persistence or HTTP concerns. */
export function createSharingService(
	store: SharingStore,
	policy: SubscriptionPolicyReader,
	invalidator: SharingInvalidator,
	config: SharingConfig,
) {
	const authorization = new SharingAuthorization(store, policy);
	const refreshes = new SharingRefreshService(store, invalidator);
	const organizations = new OrganizationService(
		store,
		policy,
		authorization,
		refreshes,
		config,
	);
	const invitations = new InvitationService(store, authorization, refreshes, config);
	const keys = new KeyRequestService(store, authorization, refreshes);

	return {
		requireOrganization: authorization.requireOrganization.bind(authorization),
		requireVault: authorization.requireVault.bind(authorization),
		requireSharing: authorization.requireSharing.bind(authorization),
		listOrganizations: organizations.listOrganizations.bind(organizations),
		organization: organizations.organization.bind(organizations),
		rename: organizations.rename.bind(organizations),
		changeMember: organizations.changeMember.bind(organizations),
		invite: invitations.invite.bind(invitations),
		resend: invitations.resend.bind(invitations),
		cancel: invitations.cancel.bind(invitations),
		invitation: invitations.invitation.bind(invitations),
		respond: invitations.respond.bind(invitations),
		listKeyRequests: keys.listKeyRequests.bind(keys),
		getKeyRequest: keys.getKeyRequest.bind(keys),
		startKeyRequest: keys.startKeyRequest.bind(keys),
		approveKeyRequest: keys.approveKeyRequest.bind(keys),
		completeKeyRequest: keys.completeKeyRequest.bind(keys),
		refresh: refreshes.refresh.bind(refreshes),
		flushRefreshes: refreshes.flush.bind(refreshes),
	};
}
