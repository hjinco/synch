import { describe, expect, it } from "vitest";
import { HTTPException } from "hono/http-exception";

import {
	requireSyncToken,
	signSyncToken,
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
	SYNC_WEBSOCKET_PROTOCOL,
} from "../../token";
import { claims, SECRET } from "./helpers";

describe("sync token request authentication", () => {
	it("reads the bearer token from a request", async () => {
		const token = await signSyncToken(claims(), SECRET);
		const verified = await requireSyncToken(
			new Request("http://example.com/v1/vaults/vault-1/socket", {
				headers: {
					authorization: `Bearer ${token}`,
				},
			}),
			SECRET,
			"vault-1",
		);

		expect(verified.sub).toBe("user-1");
	});

	it("reads the sync token from sec-websocket-protocol when authorization is unavailable", async () => {
		const token = await signSyncToken(claims(), SECRET);
		const verified = await requireSyncToken(
			new Request("http://example.com/v1/vaults/vault-1/socket", {
				headers: {
					"sec-websocket-protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token}`,
				},
			}),
			SECRET,
			"vault-1",
		);

		expect(verified.sub).toBe("user-1");
	});

	it("prefers the bearer token when both authorization and websocket protocols are present", async () => {
		const bearerToken = await signSyncToken(claims({ vaultId: "vault-1" }), SECRET);
		const protocolToken = await signSyncToken(claims({ vaultId: "vault-2" }), SECRET);
		const verified = await requireSyncToken(
			new Request("http://example.com/v1/vaults/vault-1/socket", {
				headers: {
					authorization: `Bearer ${bearerToken}`,
					"sec-websocket-protocol": `${SYNC_WEBSOCKET_PROTOCOL}, ${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${protocolToken}`,
				},
			}),
			SECRET,
			"vault-1",
		);

		expect(verified.vaultId).toBe("vault-1");
	});

	it("rejects a token for another vault", async () => {
		const token = await signSyncToken(claims({ vaultId: "vault-2" }), SECRET);

		let error: unknown;
		try {
			await requireSyncToken(
				new Request("http://example.com/v1/vaults/vault-1/socket", {
					headers: {
						authorization: `Bearer ${token}`,
					},
				}),
				SECRET,
				"vault-1",
			);
		} catch (thrown) {
			error = thrown;
		}

		expect(error).toBeInstanceOf(HTTPException);
		expect((error as HTTPException).status).toBe(403);
		await expect((error as HTTPException).getResponse().json()).resolves.toMatchObject({
			error: "forbidden",
		});
	});
});
