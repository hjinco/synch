import type { VaultGrant, KeyRequest, PasswordEnvelope } from "./types";

export type SharingVault = {
	id: string;
	organizationId: string;
	name: string;
	activeKeyVersion: number;
	sharedAt: Date | null;
};
export type SharingMembership = {
	userId: string;
	isCreator: boolean;
	explicitAccess: boolean;
	status: string;
	accessVersion: number;
};
export type OrganizationMembership = {
	organizationId: string;
	userId: string;
	role: string;
};
export type OrganizationMember = {
	id: string;
	name: string;
	email: string;
	role: string;
};
export type InvitationRecord = {
	id: string;
	organizationId: string;
	email: string;
	role: string | null;
	status: string;
	expiresAt: Date;
	createdAt: Date;
	inviterId: string;
};
export type RefreshTask = {
	vaultId: string;
	revision: string;
	createdAt: number;
};
export type CreateInvitation = {
	organizationId: string;
	email: string;
	role: string;
	inviterId: string;
	grants: VaultGrant[];
	memberLimit: number;
};

/** Persistence contract; domain and application code do not depend on Drizzle. */
export interface SharingStore {
	organizations(
		userId: string,
	): Promise<{ id: string; name: string; role: string }[]>;
	membership(
		organizationId: string,
		userId: string,
	): Promise<OrganizationMembership | null>;
	user(userId: string): Promise<{ id: string; emailVerified: boolean } | null>;
	members(organizationId: string): Promise<OrganizationMember[]>;
	organization(
		organizationId: string,
	): Promise<{ id: string; name: string } | null>;
	rename(organizationId: string, name: string): Promise<void>;
	vault(vaultId: string): Promise<SharingVault | null>;
	vaults(organizationId: string): Promise<SharingVault[]>;
	grant(vaultId: string, userId: string): Promise<SharingMembership | null>;
	grants(
		vaultId: string,
	): Promise<
		{
			userId: string;
			status: string;
			name: string;
			email: string;
		}[]
	>;
	invitations(organizationId: string): Promise<InvitationRecord[]>;
	invitation(id: string): Promise<InvitationRecord | null>;
	invitationGrants(
		id: string,
	): Promise<{ vaultId: string; name: string }[]>;
	createInvitation(input: CreateInvitation): Promise<InvitationRecord | null>;
	setInvitationStatus(id: string, status: string): Promise<void>;
	acceptInvitation(
		invite: InvitationRecord,
		userId: string,
		grants: VaultGrant[],
	): Promise<boolean>;
	addGrant(vaultId: string, userId: string): Promise<void>;
	ensureManagerGrant(vaultId: string, userId: string): Promise<void>;
	changeOrganizationRole(
		organizationId: string,
		userId: string,
		role: string,
	): Promise<void>;
	revoke(
		vaultIds: string[],
		userId: string,
		organizationId?: string,
	): Promise<void>;
	keyRequests(vaultId: string): Promise<KeyRequest[]>;
	keyRequest(id: string): Promise<KeyRequest | null>;
	createKeyRequest(request: KeyRequest): Promise<void>;
	approveKeyRequest(
		id: string,
		approvedBy: string,
		envelopeJson: string,
	): Promise<boolean>;
	passwordWrapper(
		vaultId: string,
		userId: string,
	): Promise<PasswordEnvelope | null>;
	completeKeyRequest(
		request: KeyRequest,
		envelope: PasswordEnvelope,
	): Promise<boolean>;
	audit(
		organizationId: string,
		actorId: string,
		action: string,
		targetId: string,
	): Promise<void>;
	claimInvitationDelivery(invite: InvitationRecord): Promise<boolean>;
	pruneExpiredRequests(): Promise<void>;
	refreshes(): Promise<RefreshTask[]>;
	accessVersions(vaultId: string): Promise<{ userId: string; accessVersion: number }[]>;
	queueRefresh(vaultId: string): Promise<void>;
	finishRefresh(vaultId: string, revision: string): Promise<void>;
}
