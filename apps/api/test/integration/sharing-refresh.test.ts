import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../src/db/client";
import * as schema from "../../src/db/d1";
import { DrizzleSharingStore } from "../../src/sharing/adapters/drizzle-sharing-store";
import { runScheduledTasks, SHARING_REFRESH_CRON } from "../../src/runtime/scheduled";
import {
	SYNC_WEBSOCKET_PROTOCOL,
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
} from "../../src/sync-access/application";
import { apiRequest, issueSyncToken, signUpAccount, signUpAndCreateVault } from "../helpers/api";

describe("scheduled sharing refresh", () => {
	it.each([true, false])("retries durable revocations without a management request (self-hosted=%s)", async (selfHosted) => {
		const owner = await signUpAndCreateVault();
		const member = await signUpAccount();
		const db = createDb(env.DB);
		await db.insert(schema.member).values({
			id: crypto.randomUUID(), organizationId: owner.organizationId,
			userId: member.userId, role: "member", createdAt: new Date(),
		});
		await db.insert(schema.vaultMembership).values({
			vaultId: owner.vaultId, userId: member.userId, status: "active",
		});
		const token = await issueSyncToken(member.sessionCookie, owner.vaultId, "member-device");
		const response = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token.token}`,
			},
		});
		expect(response.status).toBe(101);
		const socket = response.webSocket!;
		socket.accept();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const store = new DrizzleSharingStore(db);
			await store.revoke([owner.vaultId], member.userId);
			const tasks = await store.refreshes();
			expect(tasks).toHaveLength(1);
			// No purge binding: frequent retries must not invoke vault retention.
			const scheduledEnv = { ...env, SELF_HOSTED: selfHosted, VAULT_PURGE_QUEUE: undefined };
			await runScheduledTasks({
				...scheduledEnv,
				SYNC_COORDINATOR: {
					getByName: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
				} as unknown as typeof env.SYNC_COORDINATOR,
			}, SHARING_REFRESH_CRON);
			expect(await store.refreshes()).toEqual(tasks);
			const heartbeat = new Promise<unknown>((resolve) => socket.addEventListener("message", (event) => {
				resolve(JSON.parse(String(event.data)));
			}, { once: true }));
			socket.send(JSON.stringify({ type: "heartbeat", requestId: "during-outage" }));
			expect(await heartbeat).toMatchObject({ type: "heartbeat_ack", requestId: "during-outage" });
			const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
			await runScheduledTasks(scheduledEnv, SHARING_REFRESH_CRON);
			expect(await closed).toBe(1012);
			expect(await store.refreshes()).toEqual([]);
		} finally {
			log.mockRestore();
			if (socket.readyState === WebSocket.OPEN) socket.close();
		}
	});
});
