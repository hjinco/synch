import type { SharingStore, InvitationRecord } from "../application/store";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	ne,
	sql,
	type SQL,
} from "drizzle-orm";
import type { AppDb } from "../../db/client";
import * as s from "../../db/d1";
import type {
	VaultGrant,
	KeyRequest,
	PasswordEnvelope,
} from "../application/types";

export class DrizzleSharingStore implements SharingStore {
	constructor(readonly db: AppDb) {}

	async claimInvitationDelivery(invite: InvitationRecord): Promise<boolean> {
		const now = Date.now();
		const rows = await this.db
			.all(sql`INSERT INTO sharing_audit (id, organization_id, actor_id, action, target_id, created_at)
      SELECT ${crypto.randomUUID()}, ${invite.organizationId}, ${invite.inviterId}, 'invitation_delivery', ${invite.id}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM sharing_audit WHERE target_id=${invite.id} AND action='invitation_delivery' AND created_at>${now - 60000})
      AND (SELECT count(*) FROM sharing_audit WHERE organization_id=${invite.organizationId} AND action='invitation_delivery' AND created_at>${now - 3600000})<20 RETURNING id`);
		return rows.length > 0;
	}
	async pruneExpiredRequests() {
		await this.db
			.update(s.vaultKeyRequest)
			.set({ status: "canceled", envelopeJson: null })
			.where(
				and(
					sql`${s.vaultKeyRequest.expiresAt}<=${Date.now()}`,
					inArray(s.vaultKeyRequest.status, ["pending", "approved"]),
				),
			);
	}
	async accessVersions(vaultId: string) {
		return this.db.select({ userId: s.vaultMembership.userId, accessVersion: s.vaultMembership.accessVersion })
			.from(s.vaultMembership).where(eq(s.vaultMembership.vaultId, vaultId));
	}
	async organizations(userId: string) {
		return this.db
			.select({
				id: s.organization.id,
				name: s.organization.name,
				role: s.member.role,
			})
			.from(s.organization)
			.innerJoin(s.member, eq(s.member.organizationId, s.organization.id))
			.where(eq(s.member.userId, userId))
			.orderBy(asc(s.member.createdAt));
	}
	async membership(organizationId: string, userId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.member)
					.where(
						and(
							eq(s.member.organizationId, organizationId),
							eq(s.member.userId, userId),
						),
					)
					.limit(1)
			)[0] ?? null
		);
	}
	async user(userId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.user)
					.where(eq(s.user.id, userId))
					.limit(1)
			)[0] ?? null
		);
	}
	async members(organizationId: string) {
		return this.db
			.select({
				id: s.member.userId,
				name: s.user.name,
				email: s.user.email,
				role: s.member.role,
			})
			.from(s.member)
			.innerJoin(s.user, eq(s.user.id, s.member.userId))
			.where(eq(s.member.organizationId, organizationId));
	}
	async organization(organizationId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.organization)
					.where(eq(s.organization.id, organizationId))
					.limit(1)
			)[0] ?? null
		);
	}
	async rename(organizationId: string, name: string) {
		await this.db
			.update(s.organization)
			.set({ name })
			.where(eq(s.organization.id, organizationId));
	}
	async vault(vaultId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.vault)
					.where(and(eq(s.vault.id, vaultId), isNull(s.vault.deletedAt)))
					.limit(1)
			)[0] ?? null
		);
	}
	async vaults(organizationId: string) {
		return this.db
			.select()
			.from(s.vault)
			.where(
				and(
					eq(s.vault.organizationId, organizationId),
					isNull(s.vault.deletedAt),
				),
			);
	}
	async grants(vaultId: string) {
		return this.db
			.select({
				userId: s.vaultMembership.userId,
				status: s.vaultMembership.status,
				name: s.user.name,
				email: s.user.email,
			})
			.from(s.vaultMembership)
			.innerJoin(s.user, eq(s.user.id, s.vaultMembership.userId))
			.where(eq(s.vaultMembership.vaultId, vaultId));
	}
	async grant(vaultId: string, userId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.vaultMembership)
					.where(
						and(
							eq(s.vaultMembership.vaultId, vaultId),
							eq(s.vaultMembership.userId, userId),
						),
					)
					.limit(1)
			)[0] ?? null
		);
	}
	async invitations(organizationId: string) {
		return this.db
			.select()
			.from(s.invitation)
			.where(eq(s.invitation.organizationId, organizationId))
			.orderBy(desc(s.invitation.createdAt))
			.limit(100);
	}
	async invitation(invitationId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.invitation)
					.where(eq(s.invitation.id, invitationId))
					.limit(1)
			)[0] ?? null
		);
	}
	async invitationGrants(invitationId: string) {
		return this.db
			.select({
				vaultId: s.invitationVault.vaultId,
				name: s.vault.name,
			})
			.from(s.invitationVault)
			.innerJoin(s.vault, eq(s.vault.id, s.invitationVault.vaultId))
			.where(eq(s.invitationVault.invitationId, invitationId));
	}
	async audit(
		organizationId: string,
		actorId: string,
		action: string,
		targetId: string,
	) {
		await this.db
			.insert(s.sharingAudit)
			.values({
				id: crypto.randomUUID(),
				organizationId,
				actorId,
				action,
				targetId,
				createdAt: Date.now(),
			});
	}

	async createInvitation(input: {
		organizationId: string;
		email: string;
		role: string;
		inviterId: string;
		grants: VaultGrant[];
		memberLimit: number;
	}) {
		const id = crypto.randomUUID();
		const now = Date.now();
		const expires = now + 48 * 60 * 60 * 1000;
		// A single conditional INSERT reserves the seat, including concurrent invitations.
		const rows = await this.db.all<{ id: string }>(sql`
      INSERT INTO invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
      SELECT ${id}, ${input.organizationId}, ${input.email}, ${input.role}, 'pending', ${expires}, ${now}, ${input.inviterId}
      WHERE NOT EXISTS (SELECT 1 FROM invitation WHERE organization_id=${input.organizationId} AND lower(email)=${input.email} AND status='pending' AND expires_at>${now})
      AND NOT EXISTS (SELECT 1 FROM member JOIN user ON user.id=member.user_id WHERE member.organization_id=${input.organizationId} AND lower(user.email)=${input.email})
      AND (${input.memberLimit}=0 OR (
        (SELECT count(*) FROM member WHERE organization_id=${input.organizationId}) +
        (SELECT count(*) FROM invitation WHERE organization_id=${input.organizationId} AND status='pending' AND expires_at>${now})
      ) < ${input.memberLimit}) RETURNING id`);
		if (!rows.length) return null;
		try {
			if (input.grants.length) await this.db
				.insert(s.invitationVault)
				.values(input.grants.map((g) => ({ invitationId: id, vaultId: g.vaultId })));
		} catch (error) {
			await this.db
				.update(s.invitation)
				.set({ status: "canceled" })
				.where(eq(s.invitation.id, id));
			throw error;
		}
		return this.invitation(id);
	}
	async setInvitationStatus(id: string, status: string) {
		await this.db
			.update(s.invitation)
			.set({ status })
			.where(and(eq(s.invitation.id, id), eq(s.invitation.status, "pending")));
	}

	async acceptInvitation(
		invite: InvitationRecord,
		userId: string,
		grants: VaultGrant[],
	) {
		// Acceptance and grant creation are atomic. A conditional source prevents replay
		// after cancellation, expiry or prior acceptance from restoring revoked access.
		const pending = sql`exists (select 1 from invitation where id=${invite.id} and status='pending' and expires_at>${Date.now()})`;
		const memberId = crypto.randomUUID();
		const results = await this.db.batch([
			this.db.insert(s.member).select(
				this.db
					.select({
						id: sql<string>`${memberId}`.as("id"),
						organizationId: sql<string>`${invite.organizationId}`.as(
							"organizationId",
						),
						userId: sql<string>`${userId}`.as("userId"),
						role: sql<string>`${invite.role ?? "member"}`.as("role"),
						createdAt: sql<Date>`${Date.now()}`.as("createdAt"),
					})
					.from(s.invitation)
					.where(
						and(
							eq(s.invitation.id, invite.id),
							pending,
							sql`not exists (select 1 from member where organization_id=${invite.organizationId} and user_id=${userId})`,
						),
					),
			),
			...grants.map((g) =>
				this.db
					.insert(s.vaultMembership)
					.select(
						this.db
							.select({
								vaultId: sql<string>`${g.vaultId}`.as("vaultId"),
								userId: sql<string>`${userId}`.as("userId"),
								accessVersion: sql<number>`1`.as("accessVersion"),
								isCreator: sql<boolean>`0`.as("isCreator"),
								explicitAccess: sql<boolean>`1`.as("explicitAccess"),
								status: sql<string>`'pending_key'`.as("status"),
								joinedAt: sql<Date>`${Date.now()}`.as("joinedAt"),
								revokedAt: sql<Date>`null`.as("revokedAt"),
							})
							.from(s.invitation)
							.where(and(eq(s.invitation.id, invite.id), pending)),
					)
					.onConflictDoUpdate({
						target: [s.vaultMembership.vaultId, s.vaultMembership.userId],
						set: {
							explicitAccess: true,
							status: "pending_key",
							revokedAt: null,
							accessVersion: sql`${s.vaultMembership.accessVersion}+1`,
						},
						setWhere: eq(s.vaultMembership.status, "revoked"),
					}),
			),
			...grants.map((g) =>
				this.db
					.update(s.vault)
					.set({ sharedAt: sql`coalesce(${s.vault.sharedAt}, ${Date.now()})` })
					.where(and(eq(s.vault.id, g.vaultId), pending)),
			),
			this.db
				.update(s.invitation)
				.set({ status: "accepted" })
				.where(and(eq(s.invitation.id, invite.id), pending))
				.returning({ id: s.invitation.id }),
		]);
		return (results[results.length - 1] as unknown[]).length > 0;
	}

	async addGrant(vaultId: string, userId: string) {
		await this.db.batch([
			this.db
				.insert(s.vaultMembership)
				.values({ vaultId, userId, explicitAccess: true, status: "pending_key" })
				.onConflictDoUpdate({
					target: [s.vaultMembership.vaultId, s.vaultMembership.userId],
					set: {
						explicitAccess: true,
						status: "pending_key",
						revokedAt: null,
						accessVersion: sql`${s.vaultMembership.accessVersion}+1`,
					},
					setWhere: eq(s.vaultMembership.status, "revoked"),
				}),
			this.db
				.update(s.vault)
				.set({ sharedAt: sql`coalesce(${s.vault.sharedAt}, ${Date.now()})` })
				.where(eq(s.vault.id, vaultId)),
		]);
	}
	async ensureManagerGrant(vaultId: string, userId: string) {
		// Materialize only the key-enrollment state. Management is inherited from
		// the organization, including for vaults created after the manager joined.
		await this.db.batch([
			this.db.insert(s.vaultMembership).select(sql`
				SELECT v.id, m.user_id, 1, 0, 0, 'pending_key', ${Date.now()}, NULL
				FROM vault v JOIN member m ON m.organization_id=v.organization_id
				WHERE v.id=${vaultId} AND v.deleted_at IS NULL AND m.user_id=${userId} AND m.role IN ('owner','admin')
			`).onConflictDoUpdate({
				target: [s.vaultMembership.vaultId, s.vaultMembership.userId],
				set: { explicitAccess: false, status: "pending_key", revokedAt: null, accessVersion: sql`${s.vaultMembership.accessVersion}+1` },
				setWhere: eq(s.vaultMembership.status, "revoked"),
			}),
			this.db.update(s.vault).set({ sharedAt: sql`coalesce(${s.vault.sharedAt},${Date.now()})` }).where(and(
				eq(s.vault.id, vaultId),
				sql`(SELECT count(*) FROM vault_membership WHERE vault_id=${vaultId} AND status IN ('active','pending_key'))>1`,
			)),
		]);
	}
	async changeOrganizationRole(
		organizationId: string,
		userId: string,
		role: string,
	) {
		const update = this.db.update(s.member).set({ role }).where(and(
			eq(s.member.organizationId, organizationId), eq(s.member.userId, userId), ne(s.member.role, "owner")));
		// Evaluate inherited grants inside the same transaction as demotion so a
		// concurrent key-enrollment request cannot escape revocation.
		const inherited = sql`(select v.id from vault v join vault_membership g on g.vault_id=v.id
			join member m on m.organization_id=v.organization_id and m.user_id=g.user_id
			where v.organization_id=${organizationId} and g.user_id=${userId} and g.explicit_access=0 and m.role='member')`;
		await this.db.batch([update, ...(role === "member" ? this.revocationStatements(inherited, userId) : [])]);
	}

	async revoke(vaultIds: string[], userId: string, organizationId?: string) {
		if (!vaultIds.length) {
			if (organizationId)
				await this.db
					.delete(s.member)
					.where(
						and(
							eq(s.member.organizationId, organizationId),
							eq(s.member.userId, userId),
						),
					);
			return;
		}
		const statements = this.revocationStatements(vaultIds, userId, organizationId);
		await this.db.batch([statements[0]!, ...statements.slice(1)]);
	}
	private revocationStatements(vaultIds: string[] | SQL, userId: string, organizationId?: string) {
		if (Array.isArray(vaultIds) && !vaultIds.length) return [];
		const now = Date.now();
		return [
			this.db
				.update(s.vaultMembership)
				.set({
					status: "revoked",
					revokedAt: new Date(now),
					accessVersion: sql`${s.vaultMembership.accessVersion}+1`,
				})
				.where(
					and(
						inArray(s.vaultMembership.vaultId, vaultIds),
						eq(s.vaultMembership.userId, userId),
						ne(s.vaultMembership.status, "revoked"),
					),
				),
			this.db
				.update(s.vaultKeyWrapper)
				.set({ revokedAt: new Date(now) })
				.where(
					and(
						inArray(s.vaultKeyWrapper.vaultId, vaultIds),
						eq(s.vaultKeyWrapper.userId, userId),
					),
				),
			this.db
				.update(s.vaultKeyRequest)
				.set({ status: "canceled", envelopeJson: null })
				.where(
					and(
						inArray(s.vaultKeyRequest.vaultId, vaultIds),
						eq(s.vaultKeyRequest.userId, userId),
					),
				),
			this.db.insert(s.sharingRefresh).select(
				this.db.select({ vaultId: s.vault.id, revision: sql<string>`${crypto.randomUUID()}`.as("revision"), createdAt: sql<number>`${now}`.as("createdAt") })
					.from(s.vault).where(inArray(s.vault.id, vaultIds)),
			).onConflictDoUpdate({ target: s.sharingRefresh.vaultId, set: { revision: crypto.randomUUID(), createdAt: now } }),
			...(organizationId
				? [
						this.db
							.delete(s.member)
							.where(
								and(
									eq(s.member.organizationId, organizationId),
									eq(s.member.userId, userId),
								),
							),
					]
				: []),
		];
	}
	async refreshes() {
		return this.db.select().from(s.sharingRefresh).limit(100);
	}
	async finishRefresh(vaultId: string, revision: string) {
		await this.db
			.delete(s.sharingRefresh)
			.where(
				and(
					eq(s.sharingRefresh.vaultId, vaultId),
					eq(s.sharingRefresh.revision, revision),
				),
			);
	}
	async queueRefresh(vaultId: string) {
		await this.db
			.insert(s.sharingRefresh)
			.values({ vaultId, revision: crypto.randomUUID(), createdAt: Date.now() })
			.onConflictDoUpdate({
				target: s.sharingRefresh.vaultId,
				set: { revision: crypto.randomUUID(), createdAt: Date.now() },
			});
	}
	async keyRequests(vaultId: string) {
		return this.db
			.select()
			.from(s.vaultKeyRequest)
			.where(
				and(
					eq(s.vaultKeyRequest.vaultId, vaultId),
					inArray(s.vaultKeyRequest.status, ["pending", "approved"]),
					gt(s.vaultKeyRequest.expiresAt, Date.now()),
				),
			)
			.orderBy(asc(s.vaultKeyRequest.createdAt));
	}
	async keyRequest(id: string) {
		return (
			(
				await this.db
					.select()
					.from(s.vaultKeyRequest)
					.where(eq(s.vaultKeyRequest.id, id))
					.limit(1)
			)[0] ?? null
		);
	}
	async createKeyRequest(input: KeyRequest) {
		await this.db.batch([
			this.db
				.update(s.vaultKeyRequest)
				.set({ status: "canceled", envelopeJson: null })
				.where(
					and(
						eq(s.vaultKeyRequest.vaultId, input.vaultId),
						eq(s.vaultKeyRequest.userId, input.userId),
						inArray(s.vaultKeyRequest.status, ["pending", "approved"]),
					),
				),
			this.db.insert(s.vaultKeyRequest).values(input),
		]);
	}
	async approveKeyRequest(
		id: string,
		approvedBy: string,
		envelopeJson: string,
	) {
		return (
			(
				await this.db
					.update(s.vaultKeyRequest)
					.set({ status: "approved", approvedBy, envelopeJson })
					.where(
						and(
							eq(s.vaultKeyRequest.id, id),
							eq(s.vaultKeyRequest.status, "pending"),
							gt(s.vaultKeyRequest.expiresAt, Date.now()),
							sql`exists (select 1 from vault_membership a join vault v on v.id=a.vault_id join member o on o.organization_id=v.organization_id and o.user_id=a.user_id where a.vault_id=vault_key_request.vault_id and a.user_id=${approvedBy} and a.status='active' and o.role in ('owner','admin') and v.deleted_at is null)`,
							sql`exists (select 1 from vault_membership m where m.vault_id=vault_key_request.vault_id and m.user_id=vault_key_request.user_id and m.access_version=vault_key_request.access_version and m.status in ('active','pending_key'))`,
						),
					)
					.returning()
			).length > 0
		);
	}
	async passwordWrapper(vaultId: string, userId: string) {
		return (
			(
				await this.db
					.select()
					.from(s.vaultKeyWrapper)
					.where(
						and(
							eq(s.vaultKeyWrapper.vaultId, vaultId),
							eq(s.vaultKeyWrapper.userId, userId),
							eq(s.vaultKeyWrapper.kind, "password"),
							isNull(s.vaultKeyWrapper.revokedAt),
						),
					)
					.limit(1)
			)[0]?.envelopeJson ?? null
		);
	}
	async completeKeyRequest(request: KeyRequest, envelope: PasswordEnvelope) {
		const current = and(
			eq(s.vaultKeyRequest.id, request.id),
			eq(s.vaultKeyRequest.status, "approved"),
			gt(s.vaultKeyRequest.expiresAt, Date.now()),
			sql`exists (select 1 from vault_membership m join member o on o.user_id=m.user_id join vault v on v.id=m.vault_id and v.organization_id=o.organization_id where m.vault_id=${request.vaultId} and m.user_id=${request.userId} and m.access_version=${request.accessVersion} and m.status in ('active','pending_key'))`,
		);
		const results = await this.db.batch([
			this.db
				.insert(s.vaultKeyWrapper)
				.select(
					this.db
						.select({
							id: sql<string>`${crypto.randomUUID()}`.as("id"),
							vaultId: sql<string>`${request.vaultId}`.as("vaultId"),
							keyVersion: sql<number>`${envelope.keyVersion}`.as("keyVersion"),
							kind: sql<string>`'password'`.as("kind"),
							userId: sql<string>`${request.userId}`.as("userId"),
							envelopeJson:
								sql<PasswordEnvelope>`${JSON.stringify(envelope)}`.as(
									"envelopeJson",
								),
							createdAt: sql<Date>`${Date.now()}`.as("createdAt"),
							revokedAt: sql<Date>`null`.as("revokedAt"),
						})
						.from(s.vaultKeyRequest)
						.where(current),
				)
				.onConflictDoUpdate({
					target: [
						s.vaultKeyWrapper.vaultId,
						s.vaultKeyWrapper.kind,
						s.vaultKeyWrapper.userId,
					],
					set: { envelopeJson: envelope, revokedAt: null },
				}),
			this.db
				.update(s.vaultMembership)
				.set({ status: "active", revokedAt: null })
				.where(
					and(
						eq(s.vaultMembership.vaultId, request.vaultId),
						eq(s.vaultMembership.userId, request.userId),
						eq(s.vaultMembership.accessVersion, request.accessVersion),
						exists(
							this.db
								.select({ id: s.vaultKeyRequest.id })
								.from(s.vaultKeyRequest)
								.where(current),
						),
					),
				),
			this.db
				.update(s.vaultKeyRequest)
				.set({ status: "completed", envelopeJson: null })
				.where(current)
				.returning({ id: s.vaultKeyRequest.id }),
		]);
		return (results[2] as unknown[]).length > 0;
	}
}
