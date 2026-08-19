import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { createDb } from "../../src/db/client";
import * as schema from "../../src/db/d1";
import { createRuntimeApp } from "../../src/runtime";
import { DrizzleVaultStore } from "../../src/vault/adapters/outbound/drizzle-vault-store";
import {
	DEFAULT_VAULT_WRAPPER,
	jsonRequest,
	signUpAccount,
	signUpAndCreateVault,
} from "../helpers/api";

describe("vault integration", () => {
	it("lists the vault created by the authenticated user", async () => {
		const primary = await signUpAndCreateVault();

		const listed = await jsonRequest<{
			vaults: Array<{
				id: string;
				organizationId: string;
				name: string;
				activeKeyVersion: number;
			}>;
		}>("/v1/vaults", {
			headers: {
				cookie: primary.sessionCookie,
			},
		});

		expect(listed.response.status).toBe(200);
		expect(Array.isArray(listed.json?.vaults)).toBe(true);
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(true);
		expect(listed.json?.vaults.find((vault) => vault.id === primary.vaultId)?.name).toBe(
			primary.vaultName,
		);
		expect(
			listed.json?.vaults.find((vault) => vault.id === primary.vaultId)?.organizationId,
		).toBe(primary.organizationId);
		expect(
			listed.json?.vaults.find((vault) => vault.id === primary.vaultId)?.activeKeyVersion,
		).toBe(1);
	});

	it("returns the visible wrappers in the bootstrap response", async () => {
		const primary = await signUpAndCreateVault();

		const bootstrap = await jsonRequest<{
			vault: { id: string; organizationId: string; name: string; activeKeyVersion: number };
			wrappers: Array<{
				kind: string;
				keyVersion: number;
				envelope: { kdf: { name: string } };
			}>;
		}>(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/bootstrap`, {
			headers: {
				cookie: primary.sessionCookie,
			},
		});

		expect(bootstrap.response.status).toBe(200);
		expect(bootstrap.json?.vault.id).toBe(primary.vaultId);
		expect(bootstrap.json?.vault.organizationId).toBe(primary.organizationId);
		expect(bootstrap.json?.vault.name).toBe(primary.vaultName);
		expect(bootstrap.json?.vault.activeKeyVersion).toBe(1);
		expect(bootstrap.json?.wrappers).toHaveLength(1);
		expect(bootstrap.json?.wrappers[0]?.kind).toBe("password");
		expect(bootstrap.json?.wrappers[0]?.keyVersion).toBe(1);
		expect(bootstrap.json?.wrappers[0]?.envelope.kdf.name).toBe("argon2id");
	});

	it.each([
		{
			name: "excessive Argon2 memory",
			mutate: (wrapper: typeof DEFAULT_VAULT_WRAPPER) => {
				wrapper.envelope.kdf.memoryKiB = 1_048_576;
			},
		},
		{
			name: "invalid salt base64",
			mutate: (wrapper: typeof DEFAULT_VAULT_WRAPPER) => {
				wrapper.envelope.kdf.salt = "not-base64";
			},
		},
		{
			name: "incorrect nonce length",
			mutate: (wrapper: typeof DEFAULT_VAULT_WRAPPER) => {
				wrapper.envelope.wrap.nonce = "AAECAwQFBgc=";
			},
		},
		{
			name: "incorrect ciphertext length",
			mutate: (wrapper: typeof DEFAULT_VAULT_WRAPPER) => {
				wrapper.envelope.wrap.ciphertext =
					"c3luY3ZhdWx0LXdyYXBwZWQtdmF1bHQta2V5LXYxLXRlc3QtY2lwaGVydGV4dA==";
			},
		},
	])("rejects an unsafe vault key envelope: $name", async ({ mutate }) => {
		const account = await signUpAccount();
		const wrapper = structuredClone(DEFAULT_VAULT_WRAPPER);
		mutate(wrapper);

		const created = await jsonRequest("/v1/vaults", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: account.sessionCookie,
			},
			body: JSON.stringify({
				name: "Unsafe envelope",
				initialWrapper: wrapper,
			}),
		});

		expect(created.response.status).toBe(400);
	});

	it("rejects sync token issuance for another user's vault", async () => {
		const primary = await signUpAndCreateVault();
		const secondary = await signUpAndCreateVault();

		const denied = await jsonRequest("/v1/sync/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: primary.sessionCookie,
			},
			body: JSON.stringify({
				vaultId: secondary.vaultId,
				localVaultId: "foreign-local-vault",
			}),
		});

		expect(denied.response.status).toBe(403);
	});

	it("deletes a vault and immediately denies future access", async () => {
		const primary = await signUpAndCreateVault();

		const deleted = await jsonRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}`, {
			method: "DELETE",
			headers: {
				cookie: primary.sessionCookie,
			},
		});
		expect(deleted.response.status).toBe(202);
		expect(deleted.json).toEqual({
			vault: {
				id: primary.vaultId,
				deletionStatus: "queued",
			},
		});

		const listed = await jsonRequest<{
			vaults: Array<{ id: string; name: string }>;
		}>("/v1/vaults", {
			headers: {
				cookie: primary.sessionCookie,
			},
		});
		expect(listed.response.status).toBe(200);
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(false);

		const bootstrap = await jsonRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/bootstrap`,
			{
				headers: {
					cookie: primary.sessionCookie,
				},
			},
		);
		expect(bootstrap.response.status).toBe(403);

		const issued = await jsonRequest("/v1/sync/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: primary.sessionCookie,
			},
			body: JSON.stringify({
				vaultId: primary.vaultId,
				localVaultId: "deleted-local-vault",
			}),
		});
		expect(issued.response.status).toBe(403);
	});

	it("deletes a vault in self-hosted mode without queue bindings", async () => {
		const primary = await signUpAndCreateVault("Self Hosted Delete");
		const selfHostedEnv = {
			...env,
			SELF_HOSTED: true,
			AUTH_ALLOWED_EMAILS: primary.email,
			VAULT_PURGE_QUEUE: undefined,
			POLICY_REFRESH_QUEUE: undefined,
		} as unknown as Env;

		const deleted = await jsonRequestWithEnv(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}`,
			selfHostedEnv,
			{
				method: "DELETE",
				headers: {
					cookie: primary.sessionCookie,
				},
			},
		);
		expect(deleted.response.status).toBe(202);
		expect(deleted.json).toEqual({
			vault: {
				id: primary.vaultId,
				deletionStatus: "queued",
			},
		});

		const listed = await jsonRequestWithEnv<{ vaults: Array<{ id: string }> }>(
			"/v1/vaults",
			selfHostedEnv,
			{
				headers: {
					cookie: primary.sessionCookie,
				},
			},
		);
		expect(listed.response.status).toBe(200);
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(false);
	});

	it("rejects vault deletion without manage access", async () => {
		const primary = await signUpAndCreateVault();
		const secondary = await signUpAccount();

		const deleted = await jsonRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}`, {
			method: "DELETE",
			headers: {
				cookie: secondary.sessionCookie,
			},
		});
		expect(deleted.response.status).toBe(403);

		const listed = await jsonRequest<{
			vaults: Array<{ id: string; name: string }>;
		}>("/v1/vaults", {
			headers: {
				cookie: primary.sessionCookie,
			},
		});
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(true);
	});

	it("does not count deleted vaults against the free plan vault limit", async () => {
		const primary = await signUpAndCreateVault("Archive");

		const deleted = await jsonRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}`, {
			method: "DELETE",
			headers: {
				cookie: primary.sessionCookie,
			},
		});
		expect(deleted.response.status).toBe(202);

		const created = await jsonRequest<{ vault: { id: string; name: string } }>("/v1/vaults", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: primary.sessionCookie,
			},
			body: JSON.stringify({
				name: "Replacement",
				initialWrapper: DEFAULT_VAULT_WRAPPER,
			}),
		});
		expect(created.response.status).toBe(201);
		expect(created.json?.vault.name).toBe("Replacement");
	});

	it("rejects duplicate active vault names in the same organization", async () => {
		const primary = await signUpAndCreateVault("Shared Name");
		const duplicate = await jsonRequestWithEnv<{ vault: { id: string; name: string } }>(
			"/v1/vaults",
			{ ...env, SELF_HOSTED: true, AUTH_ALLOWED_EMAILS: primary.email },
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: primary.sessionCookie,
				},
				body: JSON.stringify({
					name: "Shared Name",
					initialWrapper: DEFAULT_VAULT_WRAPPER,
				}),
			},
		);

		expect(duplicate.response.status).toBe(409);
		expect(duplicate.text).toContain("vault_name_exists");
	});

	it("rolls back vault creation when the initial wrapper cannot be stored", async () => {
		const account = await signUpAccount();
		const db = createDb(env.DB);
		const repository = new DrizzleVaultStore(db);
		const organizationId = await repository.readDefaultOrganizationIdForUser(account.userId);
		if (!organizationId) {
			throw new Error("test account is missing an organization");
		}
		const vaultName = `Atomic Vault ${crypto.randomUUID()}`;

		await expect(
			repository.createVaultForUser(
				"missing-user",
				organizationId,
				vaultName,
				DEFAULT_VAULT_WRAPPER,
			),
		).rejects.toThrow();

		const rows = await db
			.select({ id: schema.vault.id })
			.from(schema.vault)
			.where(eq(schema.vault.name, vaultName));

		expect(rows).toEqual([]);
	});

	it("allows the same vault name in different organizations", async () => {
		const first = await signUpAndCreateVault("Reusable Name");
		const second = await signUpAndCreateVault("Reusable Name");

		expect(first.organizationId).not.toBe(second.organizationId);
		expect(first.vaultName).toBe(second.vaultName);
	});

	it("does not list organization vaults without a vault grant", async () => {
		const primary = await signUpAndCreateVault();
		const secondary = await signUpAndCreateVault();

		await addOrganizationMember(primary.organizationId, secondary.userId);

		const listed = await jsonRequest<{
			vaults: Array<{ id: string; name: string; activeKeyVersion: number }>;
		}>("/v1/vaults", {
			headers: {
				cookie: secondary.sessionCookie,
			},
		});

		expect(listed.response.status).toBe(200);
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(false);

		const denied = await jsonRequest("/v1/sync/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: secondary.sessionCookie,
			},
			body: JSON.stringify({
				vaultId: primary.vaultId,
				localVaultId: "member-local-vault",
			}),
		});
		expect(denied.response.status).toBe(403);
	});

	it("grants organization members access to individual vaults", async () => {
		const primary = await signUpAndCreateVault();
		const secondary = await signUpAccount();

		await addOrganizationMember(primary.organizationId, secondary.userId);

		const grant = await jsonRequest<{
			wrapper: { vaultId: string; userId: string | null; kind: string };
		}>(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/members`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: primary.sessionCookie,
			},
			body: JSON.stringify({
				userId: secondary.userId,
				role: "member",
				memberWrapper: {
					kind: "member",
					envelope: DEFAULT_VAULT_WRAPPER.envelope,
				},
			}),
		});
		expect(grant.response.status).toBe(201);
		expect(grant.json?.wrapper.vaultId).toBe(primary.vaultId);
		expect(grant.json?.wrapper.userId).toBe(secondary.userId);
		expect(grant.json?.wrapper.kind).toBe("member");

		const listed = await jsonRequest<{
			vaults: Array<{ id: string; name: string; activeKeyVersion: number }>;
		}>("/v1/vaults", {
			headers: {
				cookie: secondary.sessionCookie,
			},
		});
		expect(listed.response.status).toBe(200);
		expect(listed.json?.vaults.some((vault) => vault.id === primary.vaultId)).toBe(true);

		const issued = await jsonRequest<{
			token: string;
			expiresAt: number;
			vaultId: string;
			localVaultId: string;
			syncFormatVersion: number;
		}>("/v1/sync/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: secondary.sessionCookie,
			},
			body: JSON.stringify({
				vaultId: primary.vaultId,
				localVaultId: "member-local-vault",
			}),
		});

		expect(issued.response.status).toBe(200);
		expect(issued.json?.vaultId).toBe(primary.vaultId);
		expect(issued.json?.token).toBeTruthy();
		expect(issued.json?.syncFormatVersion).toBe(2);

		const bootstrap = await jsonRequest<{
			wrappers: Array<{ kind: string; userId: string | null }>;
		}>(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/bootstrap`, {
			headers: {
				cookie: secondary.sessionCookie,
			},
		});
		expect(bootstrap.response.status).toBe(200);
		expect(bootstrap.json?.wrappers).toEqual([
			expect.objectContaining({ kind: "member", userId: secondary.userId }),
		]);
	});

	it("rejects a second vault on the free plan", async () => {
		const primary = await signUpAndCreateVault("Personal");
		const duplicate = await jsonRequest<{ vault: { id: string; name: string } }>("/v1/vaults", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: primary.sessionCookie,
			},
			body: JSON.stringify({
				name: "Personal",
				initialWrapper: DEFAULT_VAULT_WRAPPER,
			}),
		});

		expect(duplicate.response.status).toBe(403);
		expect(duplicate.text).toContain("vault_limit_exceeded");
	});

	it("allows a second vault when the API runs in self-hosted mode", async () => {
		const primary = await signUpAndCreateVault("Self Hosted Personal");
		const duplicate = await jsonRequestWithEnv<{ vault: { id: string; name: string } }>(
			"/v1/vaults",
			{ ...env, SELF_HOSTED: true, AUTH_ALLOWED_EMAILS: primary.email },
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: primary.sessionCookie,
				},
				body: JSON.stringify({
					name: "Self Hosted Work",
					initialWrapper: DEFAULT_VAULT_WRAPPER,
				}),
			},
		);

		expect(duplicate.response.status).toBe(201);
		expect(duplicate.json?.vault.name).toBe("Self Hosted Work");
	});
});

async function jsonRequestWithEnv<T = unknown>(
	path: string,
	testEnv: Env,
	init: RequestInit = {},
): Promise<{ response: Response; json: T | null; text: string }> {
	const url = new URL(path, process.env.BETTER_AUTH_URL);
	const headers = new Headers(init.headers ?? {});
	if (!headers.has("origin")) {
		headers.set("origin", url.origin);
	}
	if (!headers.has("referer")) {
		headers.set("referer", `${url.origin}/`);
	}

	const request = new Request(url.toString(), {
		...init,
		headers,
	});
	const response = await createRuntimeApp(testEnv, request).fetch(request);
	const text = await response.text();

	return {
		response,
		text,
		json: text ? (JSON.parse(text) as T) : null,
	};
}

async function addOrganizationMember(
	organizationId: string,
	userId: string,
	role = "member",
): Promise<void> {
	await env.DB.prepare(
		[
			"INSERT INTO member (id, organization_id, user_id, role, created_at)",
			"VALUES (?, ?, ?, ?, ?)",
		].join(" "),
	)
		.bind(`member-${crypto.randomUUID()}`, organizationId, userId, role, Date.now())
		.run();
}
