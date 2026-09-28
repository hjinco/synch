import {
	SYNC_WEBSOCKET_PROTOCOL,
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
} from "../../src/sync-access/application";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createQueueConsumer } from "../../src/runtime";
import {
	apiRequest,
	jsonRequest,
	signUpAccount,
	signUpAndCreateVault,
	DEFAULT_VAULT_WRAPPER,
	issueSyncToken,
} from "../helpers/api";

async function plus(organizationId: string) {
	await env.DB.prepare(
		"INSERT INTO polar_subscription (id, product_id, organization_id, polar_customer_id, polar_subscription_id, status, period_end) VALUES (?, 'test-plus-monthly', ?, ?, ?, 'active', ?)",
	)
		.bind(
			crypto.randomUUID(),
			organizationId,
			crypto.randomUUID(),
			crypto.randomUUID(),
			Date.now() + 86400000,
		)
		.run();
}
async function receiverKey() {
	const key = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			hash: "SHA-256",
			modulusLength: 3072,
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		["encrypt", "decrypt"],
	);
	if (!("publicKey" in key)) throw new Error("invalid key pair");
	return btoa(
		String.fromCharCode(
			...new Uint8Array(
				(await crypto.subtle.exportKey("spki", key.publicKey)) as ArrayBuffer,
			),
		),
	);
}
const mutation = (cookie: string, body?: unknown, method = "POST") => ({
	method,
	headers: { cookie, "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("Plus organization sharing on Cloudflare", () => {
	it("uses organization roles for all vault management and revokes inherited access on demotion", async () => {
		const owner = await signUpAndCreateVault();
		const admin = await signUpAccount();
		await plus(owner.organizationId);
		await env.DB.prepare("UPDATE user SET email_verified=1 WHERE id=?").bind(admin.userId).run();
		const invite = await jsonRequest<{ id: string }>(`/v1/organizations/${owner.organizationId}/invitations`, mutation(owner.sessionCookie, {
			email: admin.email, role: "admin", vaults: [],
		}));
		expect(invite.response.status).toBe(201);
		expect((await jsonRequest(`/v1/invitations/${invite.json!.id}/accept`, mutation(admin.sessionCookie))).response.status).toBe(200);
		const organization = await jsonRequest<{ vaults: { id: string; canManage: boolean; status: string }[] }>(`/v1/organizations/${owner.organizationId}`, { headers: { cookie: admin.sessionCookie } });
		expect(organization.json!.vaults).toEqual([expect.objectContaining({ id: owner.vaultId, canManage: true, status: "pending_key" })]);
		const created = await jsonRequest<{ vault: { id: string } }>("/v1/vaults", mutation(admin.sessionCookie, {
			name: "Created by admin", organizationId: owner.organizationId, initialWrapper: DEFAULT_VAULT_WRAPPER,
		}));
		expect(created.response.status).toBe(201);
		// The owner can delete a vault created by someone else before receiving its key.
		expect((await jsonRequest(`/v1/vaults/${created.json!.vault.id}`, mutation(owner.sessionCookie, undefined, "DELETE"))).response.status).toBe(202);
		const id = crypto.randomUUID();
		const path = `/v1/vaults/${owner.vaultId}/key-requests`;
		expect((await jsonRequest(path, mutation(admin.sessionCookie, { id, publicKey: await receiverKey() }))).response.status).toBe(201);
		expect((await jsonRequest(`${path}/${id}/approve`, mutation(owner.sessionCookie, {
			envelope: { version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "A".repeat(512) },
		}))).response.status).toBe(200);
		expect((await jsonRequest(`${path}/${id}/complete`, mutation(admin.sessionCookie, {
			envelope: { ...DEFAULT_VAULT_WRAPPER.envelope, version: 2, binding: { vaultId: owner.vaultId, userId: admin.userId } },
		}))).response.status).toBe(200);
		const token = await issueSyncToken(admin.sessionCookie, owner.vaultId, "admin-device");
		expect((await jsonRequest(`/v1/organizations/${owner.organizationId}/members/${admin.userId}`, mutation(owner.sessionCookie, { role: "member" }, "PATCH"))).response.status).toBe(200);
		expect((await jsonRequest(`/v1/vaults/${owner.vaultId}/bootstrap`, { headers: { cookie: admin.sessionCookie } })).response.status).toBe(403);
		expect((await apiRequest(`/v1/vaults/${owner.vaultId}/blobs/denied`, { headers: { authorization: `Bearer ${token.token}` } })).status).toBe(403);
		expect((await jsonRequest(`/v1/vaults/${owner.vaultId}`, mutation(admin.sessionCookie, undefined, "DELETE"))).response.status).toBe(403);
	});

	it("revokes existing tokens and sockets, then allows sync after access is granted again", async () => {
		const owner = await signUpAndCreateVault();
		const member = await signUpAccount();
		await env.DB.prepare("UPDATE user SET email_verified=1 WHERE id=?")
			.bind(member.userId)
			.run();
		const invites = `/v1/organizations/${owner.organizationId}/invitations`;
		const input = {
			email: member.email,
			role: "member",
			vaults: [{ vaultId: owner.vaultId }],
		};
		expect(
			(await jsonRequest(invites, mutation(owner.sessionCookie, input)))
				.response.status,
		).toBe(403);
		expect(
			(
				await apiRequest(
					"/api/auth/organization/invite-member",
					mutation(owner.sessionCookie, {
						organizationId: owner.organizationId,
						email: member.email,
						role: "member",
					}),
				)
			).status,
		).toBe(403);
		await plus(owner.organizationId);
		expect((await jsonRequest(invites, mutation(owner.sessionCookie, {
			...input, vaults: [{ vaultId: owner.vaultId, role: "admin" }],
		}))).response.status).toBe(400);
		expect(
			(
				await apiRequest(invites, {
					...mutation(owner.sessionCookie, input),
					headers: {
						...mutation(owner.sessionCookie).headers,
						origin: "https://untrusted.example",
					},
				})
			).status,
		).toBe(403);
		const invited = await jsonRequest<{ id: string }>(
			invites,
			mutation(owner.sessionCookie, input),
		);
		expect(invited.response.status).toBe(201);
		const inviteId = invited.json!.id;
		expect(
			(
				await jsonRequest(
					`/v1/invitations/${inviteId}/accept`,
					mutation(owner.sessionCookie),
				)
			).response.status,
		).toBe(403);
		expect(
			(
				await jsonRequest(
					`/v1/invitations/${inviteId}/accept`,
					mutation(member.sessionCookie),
				)
			).response.status,
		).toBe(200);
		expect(
			(
				await jsonRequest(`/v1/vaults/${owner.vaultId}/bootstrap`, {
					headers: { cookie: member.sessionCookie },
				})
			).response.status,
		).toBe(403);
		const requestId = crypto.randomUUID();
		const path = `/v1/vaults/${owner.vaultId}/key-requests`;
		const requested = await jsonRequest(
			path,
			mutation(member.sessionCookie, {
				id: requestId,
				publicKey: await receiverKey(),
			}),
		);
		expect(requested.response.status).toBe(201);
		expect(
			(
				await jsonRequest(
					`${path}/${requestId}/approve`,
					mutation(member.sessionCookie, {
						envelope: {
							version: 1,
							algorithm: "rsa-oaep-sha256",
							ciphertext: "A".repeat(512),
						},
					}),
				)
			).response.status,
		).toBe(403);
		expect(
			(
				await jsonRequest(
					`${path}/${requestId}/approve`,
					mutation(owner.sessionCookie, {
						envelope: {
							version: 1,
							algorithm: "rsa-oaep-sha256",
							ciphertext: "A".repeat(512),
						},
					}),
				)
			).response.status,
		).toBe(200);
		const envelope = {
			...DEFAULT_VAULT_WRAPPER.envelope,
			version: 2,
			binding: { vaultId: owner.vaultId, userId: member.userId },
		};
		expect(
			(
				await jsonRequest(
					`${path}/${requestId}/complete`,
					mutation(member.sessionCookie, { envelope }),
				)
			).response.status,
		).toBe(200);
		const bootstrap = await jsonRequest<{
			wrappers: { userId: string; envelope: unknown }[];
		}>(`/v1/vaults/${owner.vaultId}/bootstrap`, {
			headers: { cookie: member.sessionCookie },
		});
		expect(bootstrap.json?.wrappers).toHaveLength(1);
		expect(bootstrap.json!.wrappers[0].userId).toBe(member.userId);
		const issued = await issueSyncToken(
			member.sessionCookie,
			owner.vaultId,
			"member-device",
		);
		const connected = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${issued.token}`,
			},
		});
		expect(connected.status).toBe(101);
		const socket = connected.webSocket!;
		socket.accept();
		const ownerToken = await issueSyncToken(owner.sessionCookie, owner.vaultId, "owner-device");
		const ownerConnection = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${ownerToken.token}` },
		});
		expect(ownerConnection.status).toBe(101);
		const ownerSocket = ownerConnection.webSocket!;
		ownerSocket.accept();
		// Every member with active vault access can edit encrypted content.
		expect((await apiRequest(`/v1/vaults/${owner.vaultId}/blobs/member-edit`, {
			method: "PUT", headers: { authorization: `Bearer ${issued.token}`, "x-blob-size": "17" }, body: "member ciphertext",
		})).status).toBe(201);
		expect((await jsonRequest(`/v1/vaults/${owner.vaultId}`, mutation(member.sessionCookie, undefined, "DELETE"))).response.status).toBe(403);
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (event) => resolve(event.code)),
		);
		expect(
			(
				await jsonRequest(
					`/v1/vaults/${owner.vaultId}/members/${member.userId}`,
					mutation(owner.sessionCookie, undefined, "DELETE"),
				)
			).response.status,
		).toBe(200);
		expect(await closed).toBe(1012);
		const ownerReply = new Promise<unknown>((resolve) => ownerSocket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
		ownerSocket.send(JSON.stringify({ type: "heartbeat", requestId: "owner-still-connected" }));
		expect(await ownerReply).toMatchObject({ type: "heartbeat_ack", requestId: "owner-still-connected" });
		ownerSocket.close();
		const revocations = await runInDurableObject(env.SYNC_COORDINATOR.getByName(owner.vaultId), async (_, state) =>
			state.storage.sql.exec("SELECT key, minimum_version FROM sync_access_revocations").toArray(),
		);
		expect(revocations).toContainEqual({ key: `user:${member.userId}`, minimum_version: 2 });
		expect(
			(
				await apiRequest(`/v1/vaults/${owner.vaultId}/blobs/old-blob`, {
					headers: { authorization: `Bearer ${issued.token}` },
				})
			).status,
		).toBe(403);
		expect(
			(
				await jsonRequest(
					"/v1/sync/token",
					mutation(member.sessionCookie, {
						vaultId: owner.vaultId,
						localVaultId: "member-device",
					}),
				)
			).response.status,
		).toBe(403);
		expect(
			(
				await jsonRequest(
					`/v1/invitations/${inviteId}/accept`,
					mutation(member.sessionCookie),
				)
			).response.status,
		).toBe(200);
		expect(
			(
				await jsonRequest(`/v1/vaults/${owner.vaultId}/bootstrap`, {
					headers: { cookie: member.sessionCookie },
				})
			).response.status,
		).toBe(403);

		// Regranting access must require fresh key approval and a fresh token.
		expect((await jsonRequest(`/v1/vaults/${owner.vaultId}/grants`, mutation(owner.sessionCookie, {
			userId: member.userId,
		}))).response.status).toBe(200);
		const renewedRequestId = crypto.randomUUID();
		expect((await jsonRequest(path, mutation(member.sessionCookie, {
			id: renewedRequestId, publicKey: await receiverKey(),
		}))).response.status).toBe(201);
		expect((await jsonRequest(`${path}/${renewedRequestId}/approve`, mutation(owner.sessionCookie, {
			envelope: { version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "A".repeat(512) },
		}))).response.status).toBe(200);
		expect((await jsonRequest(`${path}/${renewedRequestId}/complete`, mutation(member.sessionCookie, {
			envelope,
		}))).response.status).toBe(200);
		const membership = await env.DB.prepare("SELECT access_version FROM vault_membership WHERE vault_id=? AND user_id=?")
			.bind(owner.vaultId, member.userId).first<{ access_version: number }>();
		expect(membership?.access_version).toBe(3);
		expect((await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${issued.token}`,
			},
		})).status).toBe(403);
		const renewed = await issueSyncToken(member.sessionCookie, owner.vaultId, "member-device");
		const reconnected = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${renewed.token}`,
			},
		});
		expect(reconnected.status).toBe(101);
		const renewedSocket = reconnected.webSocket!;
		renewedSocket.accept();
		try {
			const reply = new Promise<unknown>((resolve) =>
				renewedSocket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }),
			);
			renewedSocket.send(JSON.stringify({ type: "hello", requestId: "renewed-hello", lastKnownCursor: 0 }));
			expect(await reply).toMatchObject({ type: "hello_ack", requestId: "renewed-hello" });
		} finally {
			renewedSocket.close();
		}
	});
	it("suspends shared sync on subscription notifications and preserves retention and membership", async () => {
		const owner = await signUpAndCreateVault();
		await plus(owner.organizationId);
		await env.DB.prepare("UPDATE vault SET shared_at=? WHERE id=?")
			.bind(Date.now(), owner.vaultId)
			.run();
		const issued = await issueSyncToken(
			owner.sessionCookie,
			owner.vaultId,
			"owner-device",
		);

		const connected = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${issued.token}`,
			},
		});
		expect(connected.status).toBe(101);
		connected.webSocket!.accept();
		expect(
			(
				await apiRequest(`/v1/vaults/${owner.vaultId}/blobs/paused-history`, {
					method: "PUT",
					headers: {
						authorization: `Bearer ${issued.token}`,
						"x-blob-size": "19",
					},
					body: "retained ciphertext",
				})
			).status,
		).toBe(201);
		const closed = new Promise<number>((resolve) =>
			connected.webSocket!.addEventListener("close", (event) =>
				resolve(event.code),
			),
		);
		await env.DB.prepare("UPDATE polar_subscription SET period_end=? WHERE organization_id=?")
			.bind(Date.now() - 1, owner.organizationId).run();
		// The DO does not poll D1 or track subscription dates. The webhook's queued
		// policy refresh closes the socket, including clients that are idle.
		const stillConnected = new Promise<unknown>((resolve) =>
			connected.webSocket!.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }),
		);
		connected.webSocket!.send(JSON.stringify({ type: "heartbeat", requestId: "before-webhook" }));
		expect(await stillConnected).toMatchObject({ type: "heartbeat_ack", requestId: "before-webhook" });
		await deliverPolicyRefresh(owner.organizationId);
		expect(await closed).toBe(1012);
		expect((await apiRequest(`/v1/vaults/${owner.vaultId}/blobs/paused-history`, {
			headers: { authorization: `Bearer ${issued.token}` },
		})).status).toBe(403);
		expect((await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${issued.token}` },
		})).status).toBe(403);
		const stub = env.SYNC_COORDINATOR.getByName(owner.vaultId);
		await runInDurableObject(stub, async (instance, state) => {
			const expiredAt = Date.now() - 1;
			state.storage.sql.exec(
				"UPDATE blobs SET delete_after=? WHERE blob_id='paused-history'",
				expiredAt,
			);
			state.storage.sql.exec(
				`INSERT INTO entry_versions (
        version_id, entry_id, source_revision, op_type, blob_id, encrypted_metadata,
        reason, bucket_start_ms, captured_at, expires_at, created_by_user_id, created_by_local_vault_id
      ) VALUES ('retained-version', 'old-entry', 1, 'upsert', 'paused-history', 'ciphertext', 'auto', NULL, 1, ?, 'owner', 'device')`,
				expiredAt,
			);
			await (instance as unknown as { runGc(): Promise<void> }).runGc();
			expect(
				state.storage.sql
					.exec(
						"SELECT version_id FROM entry_versions WHERE version_id='retained-version'",
					)
					.toArray(),
			).toHaveLength(1);
			expect(
				state.storage.sql
					.exec("SELECT blob_id FROM blobs WHERE blob_id='paused-history'")
					.toArray(),
			).toHaveLength(1);
		});
		const denied = await jsonRequest(
			"/v1/sync/token",
			mutation(owner.sessionCookie, {
				vaultId: owner.vaultId,
				localVaultId: "owner-device",
			}),
		);
		expect(denied.response.status).toBe(403);
		expect(denied.text).toContain("sharing_suspended");
		const row = await runInDurableObject(
			stub,
			async (_, state) =>
				state.storage.sql
					.exec<{
						days: number;
					}>(
						"SELECT version_history_retention_days AS days FROM coordinator_state",
					)
					.toArray()[0],
		);
		expect(row.days).toBe(365);
		expect(
			(
				await env.DB.prepare(
					"SELECT status FROM vault_membership WHERE vault_id=?",
				)
					.bind(owner.vaultId)
					.first<{ status: string }>()
			)?.status,
		).toBe("active");
		await env.DB.prepare(
			"UPDATE polar_subscription SET period_end=? WHERE organization_id=?",
		)
			.bind(Date.now() + 86400000, owner.organizationId)
			.run();
		await deliverPolicyRefresh(owner.organizationId);
		const renewed = await issueSyncToken(owner.sessionCookie, owner.vaultId, "renewed-owner-device");
		const resumed = await apiRequest(`/v1/vaults/${owner.vaultId}/socket`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${renewed.token}` },
		});
		expect(resumed.status).toBe(101);
		resumed.webSocket!.accept();
		resumed.webSocket!.close();
		expect(
			(
				await jsonRequest(
					"/v1/sync/token",
					mutation(owner.sessionCookie, {
						vaultId: owner.vaultId,
						localVaultId: "owner-device",
					}),
				)
			).response.status,
		).toBe(200);
	});
});

async function deliverPolicyRefresh(organizationId: string): Promise<void> {
	const message = {
		body: { type: "subscription_policy_refresh", organizationId },
		ack: vi.fn(),
		retry: vi.fn(),
	};
	await createQueueConsumer(env).handleBatch({ messages: [message] } as never);
	expect(message.ack).toHaveBeenCalledOnce();
	expect(message.retry).not.toHaveBeenCalled();
}
