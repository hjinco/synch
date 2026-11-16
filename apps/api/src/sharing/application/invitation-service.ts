import type { SharingStore } from "./store";
import { forbidden, type SharingAuthorization } from "./authorization";
import type { SharingRefreshService } from "./refresh";
import { SharingError, type SharingActor } from "./types";
import type { InvitationEmailSender } from "./ports/invitation-email-sender";

export type InvitationConfig = {
	baseURL: string;
	requireVerifiedEmail: boolean;
	allowedEmails?: string;
	invitationEmail?: InvitationEmailSender;
};

export class InvitationService {
	constructor(
		private readonly store: SharingStore,
		private readonly authorization: SharingAuthorization,
		private readonly refreshes: SharingRefreshService,
		private readonly config: InvitationConfig,
	) {}

	async invite(
		actor: SharingActor,
		organizationId: string,
		input: { email: string; role: "admin" | "member" },
	) {
		const inviter = await this.authorization.requireOrganization(
			actor.id,
			organizationId,
			true,
		);
		if (input.role === "admin" && inviter.role !== "owner") forbidden();
		const policy = await this.authorization.requireSharing(organizationId);
		const email = input.email.trim().toLowerCase();
		const allowed = this.config.allowedEmails
			?.split(",")
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean);
		if (allowed?.length && !allowed.includes(email))
			throw new SharingError(
				400,
				"email_not_allowed",
				"This server's account allowlist does not include that email",
			);
		const invitation = await this.store.createInvitation({
			organizationId,
			email,
			role: input.role,
			inviterId: actor.id,
			memberLimit: policy.memberLimit,
		});
		if (!invitation)
			throw new SharingError(
				409,
				"invitation_conflict",
				"Member limit reached, or this person is already a member or invited",
			);
		await this.store.audit(organizationId, actor.id, "invited", invitation.id);
		return this.deliverInvitation(invitation.id, invitation.email);
	}

	private async deliverInvitation(id: string, email: string) {
		const url = new URL("/invitations", this.config.baseURL);
		url.searchParams.set("invitationId", id);
		let emailSent = false;
		if (this.config.invitationEmail) {
			const invite = await this.store.invitation(id);
			if (!invite || !(await this.store.claimInvitationDelivery(invite)))
				throw new SharingError(
					429,
					"delivery_rate_limited",
					"Wait a minute before resending this invitation",
				);
			try {
				await this.config.invitationEmail.send(email, url.toString());
				emailSent = true;
			} catch {
				/* The durable invitation remains visible and can be resent. */
			}
		}
		return { id, url: url.toString(), emailSent };
	}

	async resend(userId: string, organizationId: string, id: string) {
		await this.authorization.requireOrganization(userId, organizationId, true);
		await this.authorization.requireSharing(organizationId);
		const invite = await this.store.invitation(id);
		if (
			!invite ||
			invite.organizationId !== organizationId ||
			invite.status !== "pending" ||
			invite.expiresAt.getTime() <= Date.now()
		)
			throw new SharingError(
				409,
				"invitation_unavailable",
				"Create a new invitation for expired or canceled invitations",
			);
		return this.deliverInvitation(id, invite.email);
	}

	async cancel(userId: string, organizationId: string, id: string) {
		await this.authorization.requireOrganization(userId, organizationId, true);
		const invite = await this.store.invitation(id);
		if (!invite || invite.organizationId !== organizationId) forbidden();
		await this.store.setInvitationStatus(id, "canceled");
		await this.store.audit(organizationId, userId, "invitation_canceled", id);
	}

	private async recipient(actor: SharingActor, id: string) {
		const invite = await this.store.invitation(id);
		const user = await this.store.user(actor.id);
		if (!invite || invite.email.toLowerCase() !== actor.email.toLowerCase())
			forbidden();
		if (this.config.requireVerifiedEmail && !user?.emailVerified)
			throw new SharingError(
				403,
				"verify_email",
				"Verify your email before opening an invitation",
			);
		return invite;
	}

	async invitation(actor: SharingActor, id: string) {
		const invite = await this.recipient(actor, id);
		const org = await this.store.organization(invite.organizationId);
		return {
			id,
			organizationId: invite.organizationId,
			organizationName: org?.name,
			role: invite.role,
			status:
				invite.expiresAt.getTime() <= Date.now() && invite.status === "pending"
					? "expired"
					: invite.status,
			vaults: (await this.store.vaults(invite.organizationId)).map((vault) => ({
				vaultId: vault.id,
				name: vault.name,
			})),
		};
	}

	async respond(actor: SharingActor, id: string, accept: boolean) {
		const invite = await this.recipient(actor, id);
		if (invite.status === "accepted")
			return { organizationId: invite.organizationId };
		if (invite.status !== "pending" || invite.expiresAt.getTime() <= Date.now())
			throw new SharingError(
				409,
				"invitation_unavailable",
				"Invitation expired or canceled",
			);
		if (!accept) {
			await this.store.setInvitationStatus(id, "rejected");
			return { organizationId: invite.organizationId };
		}
		await this.authorization.requireSharing(invite.organizationId);
		const inviter = await this.authorization.requireOrganization(
			invite.inviterId,
			invite.organizationId,
			true,
		);
		if (invite.role === "admin" && inviter.role !== "owner") forbidden();
		if (
			!(await this.store.acceptInvitation(
				invite,
				actor.id,
			))
		)
			throw new SharingError(
				409,
				"invitation_changed",
				"Invitation changed; refresh and try again",
			);
		await this.refreshes.flush();
		await this.store.audit(
			invite.organizationId,
			actor.id,
			"invitation_accepted",
			id,
		);
		return { organizationId: invite.organizationId };
	}
}
