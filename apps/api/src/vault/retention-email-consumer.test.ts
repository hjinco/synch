import { describe, expect, it, vi } from "vitest";

import { VaultRetentionEmailConsumer } from "./retention-email-consumer";
import type { VaultRetentionEmailMessage } from "./retention-queue";

const DELETED_AT = Date.UTC(2026, 7, 14, 12);

function queueMessage(
	overrides: Partial<VaultRetentionEmailMessage> = {},
) {
	return {
		body: {
			type: "vault_retention_email",
			vaultId: "vault-1",
			deletedAt: DELETED_AT,
			notice: {
				vaultName: "Work",
				ownerEmail: "owner@example.com",
				lastCommitAt: null,
			},
			...overrides,
		} satisfies VaultRetentionEmailMessage,
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

describe("VaultRetentionEmailConsumer", () => {
	it("sends the deletion notice to the vault owner", async () => {
		const email = { send: vi.fn(async () => ({ messageId: "provider-1" })) };
		const message = queueMessage();

		await new VaultRetentionEmailConsumer(
			email as never,
			"Synch <noreply@synch.run>",
		).handleMessage(message as never);

		expect(email.send).toHaveBeenCalledWith(
			expect.objectContaining({
				from: "Synch <noreply@synch.run>",
				to: "owner@example.com",
			}),
		);
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it("retries when delivery fails", async () => {
		const email = {
			send: vi.fn(async () => {
				throw new Error("email unavailable");
			}),
		};
		const message = queueMessage();

		await new VaultRetentionEmailConsumer(
			email as never,
			"Synch <noreply@synch.run>",
		).handleMessage(message as never);

		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});

	it("retries rather than dropping the notice when email is not configured", async () => {
		const message = queueMessage();

		await new VaultRetentionEmailConsumer(undefined, undefined).handleMessage(
			message as never,
		);

		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});
});
