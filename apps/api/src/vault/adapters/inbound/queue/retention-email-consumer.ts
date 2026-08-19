import type { VaultRetentionEmailMessage } from "../../../application/dto/queue-messages";
import type { RetentionEmailSender } from "../../../application/ports/outbound/retention-email-sender";
import { FREE_VAULT_INACTIVITY_DELETE_AFTER_MS } from "../../../application/use-cases/run-vault-retention";

const INACTIVITY_DAYS = Math.round(
	FREE_VAULT_INACTIVITY_DELETE_AFTER_MS / (24 * 60 * 60 * 1000),
);

export class VaultRetentionEmailConsumer {
	constructor(
		private readonly emailSender: RetentionEmailSender,
	) {}

	async handleMessage(message: Message<VaultRetentionEmailMessage>): Promise<void> {
		const body = message.body;
		if (
			body?.type !== "vault_retention_email" ||
			!body.notice?.ownerEmail.trim()
		) {
			message.ack();
			return;
		}
		try {
			const content = renderDeletionNotice(body);
			await this.emailSender.send({
				to: body.notice.ownerEmail,
				subject: content.subject,
				text: content.text,
				html: content.html,
			});
			message.ack();
		} catch {
			message.retry();
		}
	}
}

function renderDeletionNotice(message: VaultRetentionEmailMessage): {
	subject: string;
	text: string;
	html: string;
} {
	const { vaultName, lastCommitAt } = message.notice;
	const lastChange =
		lastCommitAt === null
			? "No vault content had been synced since the remote vault was created."
			: `The last synced content change was ${formatTimestamp(lastCommitAt)}.`;
	const lines = [
		`Your free Synch remote vault “${vaultName}” was permanently deleted on ${formatTimestamp(message.deletedAt)}.`,
		`Remote vaults on the free plan are deleted after ${INACTIVITY_DAYS} days without a synced content change. ${lastChange}`,
		"",
		"Your local Obsidian vault was not touched. Only the encrypted copy stored by Synch was removed, and Synch cannot recover it.",
		"To sync this vault again, set it up as a new remote vault in the Synch plugin.",
	];

	return {
		subject: `Synch remote vault deleted: ${vaultName}`,
		text: lines.join("\n"),
		html: lines
			.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : ""))
			.join(""),
	};
}

function formatTimestamp(value: number): string {
	return new Date(value).toISOString();
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			}[char] ?? char),
	);
}
