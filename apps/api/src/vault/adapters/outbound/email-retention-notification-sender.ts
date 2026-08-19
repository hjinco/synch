import type {
	RetentionEmail,
	RetentionEmailSender,
} from "../../application/ports/outbound/retention-email-sender";

export class EmailRetentionNotificationSender implements RetentionEmailSender {
	constructor(
		private readonly email: SendEmail | undefined,
		private readonly emailFrom: string | undefined,
	) {}

	async send(message: RetentionEmail): Promise<void> {
		if (!this.email || !this.emailFrom?.trim()) {
			throw new Error("retention email delivery is not configured");
		}

		await this.email.send({
			from: this.emailFrom,
			to: message.to,
			subject: message.subject,
			text: message.text,
			html: message.html,
		});
	}
}
