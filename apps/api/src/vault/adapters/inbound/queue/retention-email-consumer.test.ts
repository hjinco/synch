import { describe, expect, it, vi } from "vitest";

import type { VaultRetentionEmailMessage } from "../../../application/dto/queue-messages";
import { VaultRetentionEmailConsumer } from "./retention-email-consumer";

const DELETED_AT = Date.UTC(2026, 7, 14, 12);

function queueMessage(): {
	body: VaultRetentionEmailMessage;
	ack: ReturnType<typeof vi.fn>;
	retry: ReturnType<typeof vi.fn>;
} {
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
		},
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

describe("VaultRetentionEmailConsumer", () => {
	it("sends and acknowledges deletion notices", async () => {
		const email = { send: vi.fn(async () => {}) };
		const message = queueMessage();

		await new VaultRetentionEmailConsumer({ send: email.send }).handleMessage(
			message as never,
		);

		expect(email.send).toHaveBeenCalledWith(
			expect.objectContaining({ to: "owner@example.com" }),
		);
		expect(message.ack).toHaveBeenCalledOnce();
	});

	it("retries on delivery failure or missing configuration", async () => {
		const failing = queueMessage();
		await new VaultRetentionEmailConsumer({
			send: vi.fn(async () => { throw new Error("email unavailable"); }),
		}).handleMessage(failing as never);
		expect(failing.retry).toHaveBeenCalledOnce();

		const missing = queueMessage();
		await new VaultRetentionEmailConsumer({
			send: vi.fn(async () => { throw new Error("not configured"); }),
		}).handleMessage(missing as never);
		expect(missing.retry).toHaveBeenCalledOnce();
	});
});
