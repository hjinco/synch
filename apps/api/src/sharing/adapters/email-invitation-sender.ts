import type { EmailSender } from "../../platform/email";
import type { InvitationEmailSender } from "../application/ports/invitation-email-sender";

export class EmailInvitationSender implements InvitationEmailSender {
	constructor(
		private readonly email: EmailSender,
		private readonly from: string,
	) {}

	async send(email: string, invitationUrl: string): Promise<void> {
		await this.email.send({
			from: this.from,
			to: email,
			subject: "Invitation to a Synch organization",
			text: `Sign in with this email address to review your Synch invitation:\n\n${invitationUrl}\n\nYour vault password and encryption keys are never included in invitations.`,
		});
	}
}
