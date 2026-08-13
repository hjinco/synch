import { serve, type ServerType } from "@hono/node-server";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createNodeRuntime, type NodeRuntime } from "../../src/runtime/node";
import { createNodeWebSocketUpgradeHandler } from "../../src/runtime/node-websocket";
import { LocalDiskBlobStorage } from "../../src/sync/blob/local-disk-storage";
import { SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX, SYNC_WEBSOCKET_PROTOCOL } from "../../src/sync/access/token";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_BIN = path.join(API_ROOT, "node_modules/.bin/tsx");

const DEFAULT_VAULT_WRAPPER = {
	kind: "password" as const,
	envelope: {
		version: 1,
		keyVersion: 1,
		kdf: {
			name: "argon2id",
			memoryKiB: 65_536,
			iterations: 3,
			parallelism: 1,
			salt: "MDEyMzQ1Njc4OWFiY2RlZg==",
		},
		wrap: {
			algorithm: "aes-256-gcm",
			nonce: "AAECAwQFBgcICQoL",
			ciphertext: "c3luY2h2YXVsdC13cmFwcGVkLXZhdWx0LWtleS12MS10ZXN0LWNpcGhlcnRleHQh",
		},
	},
};

const SELF_HOST_ALLOWED_EMAIL = "self-host-e2e@test.invalid";

let counter = 0;
function uniqueId(prefix: string): string {
	counter += 1;
	return `${prefix}-${Date.now()}-${counter}`;
}

/** Reserves a free TCP port synchronously so `publicUrl` (needed for better-auth's trusted-origin check) can be correct *before* the real server binds - `port: 0` only tells you the port after listening starts. */
async function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => {
				if (!address || typeof address === "string") {
					reject(new Error("failed to reserve a free port"));
					return;
				}
				resolve(address.port);
			});
		});
	});
}

/** Boots a full self-hosted Node runtime (libSQL app DB + SQLite coordinator + local disk blobs) against an ephemeral port. */
async function bootServer(existingDataDir?: string) {
	const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), "synch-self-host-e2e-"));
	const port = await reserveFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const runtime = await createNodeRuntime({
		dataDir,
		publicUrl: baseUrl,
		betterAuthSecret: "test-secret-test-secret-test-secret",
		authAllowedEmails: SELF_HOST_ALLOWED_EMAIL,
		syncTokenSecret: "test-sync-token-secret-test-sync",
		blobStorage: new LocalDiskBlobStorage(path.join(dataDir, "blobs")),
	});
	const { wss, handleUpgrade } = createNodeWebSocketUpgradeHandler(runtime, baseUrl);
	const server = serve({ fetch: (request) => runtime.fetch(request), port });
	server.on("upgrade", handleUpgrade);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	return { dataDir, runtime, server, wss, baseUrl };
}

function closeServer(server: ServerType, wss: import("ws").WebSocketServer): Promise<void> {
	return new Promise((resolve) => {
		wss.close();
		server.close(() => resolve());
	});
}

async function waitForHealth(baseUrl: string, deadline = Date.now() + 10_000): Promise<void> {
	for (;;) {
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) {
				return;
			}
		} catch {
			// server not accepting connections yet
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${baseUrl}/health`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * Spawns the real CLI entrypoint (`self-host.ts`, via `tsx`) as an actual OS
 * process, so it can be killed with SIGKILL. An in-process `runtime.dispose()`
 * always closes SQLite cleanly (checkpointing the WAL); a SIGKILL leaves an
 * uncheckpointed `-wal` file behind, which is the actual crash-recovery path
 * `locking_mode = EXCLUSIVE` + WAL replay needs to be exercised against.
 */
async function bootSubprocessServer(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
	const port = await reserveFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	// `detached: true` makes this child the leader of its own process group.
	// `tsx`'s CLI itself spawns a grandchild node process (rather than
	// exec-ing in place) to run the actual app, so SIGKILL-ing just the
	// direct child pid leaves that grandchild running - and still holding
	// the vault's exclusive SQLite lock forever. Killing the whole group
	// (via a negative pid, see `killAndWaitForExit`) reaches it too.
	const child = spawn(TSX_BIN, ["src/self-host.ts"], {
		cwd: API_ROOT,
			env: {
			...process.env,
			DATA_DIR: dataDir,
			PORT: String(port),
			PUBLIC_URL: baseUrl,
			BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
			AUTH_ALLOWED_EMAILS: SELF_HOST_ALLOWED_EMAIL,
			SYNC_TOKEN_SECRET: "test-sync-token-secret-test-sync",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exited = new Promise<never>((_resolve, reject) => {
		child.once("exit", (code, signal) => {
			reject(new Error(`self-host process exited early (code=${code}, signal=${signal}): ${stderr}`));
		});
	});
	await Promise.race([waitForHealth(baseUrl), exited]);
	child.removeAllListeners("exit");
	return { baseUrl, child };
}

function killAndWaitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
		// Negative pid targets the whole process group (see the `detached: true`
		// comment in `bootSubprocessServer` for why a plain `child.kill()` isn't
		// enough to reach tsx's grandchild node process).
		if (typeof child.pid === "number") {
			try {
				process.kill(-child.pid, "SIGKILL");
				return;
			} catch {
				// group already gone; fall through to killing the direct child
			}
		}
		child.kill("SIGKILL");
	});
}

async function signUpAndCreateVault(baseUrl: string) {
	const email = SELF_HOST_ALLOWED_EMAIL;
	const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl },
		body: JSON.stringify({ email, password: "correct horse battery staple", name: "E2E" }),
	});
	expect(signUp.status).toBeLessThan(300);
	const sessionCookie = signUp.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
	expect(sessionCookie).not.toBe("");

	const createdVault = await fetch(`${baseUrl}/v1/vaults`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: sessionCookie,
			origin: baseUrl,
		},
		body: JSON.stringify({ name: uniqueId("vault"), initialWrapper: DEFAULT_VAULT_WRAPPER }),
	});
	expect(createdVault.status).toBeLessThan(300);
	const createdVaultJson = (await createdVault.json()) as { vault: { id: string } };

	return { sessionCookie, vaultId: createdVaultJson.vault.id };
}

async function issueSyncToken(baseUrl: string, sessionCookie: string, vaultId: string, localVaultId: string) {
	const response = await fetch(`${baseUrl}/v1/sync/token`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: sessionCookie, origin: baseUrl },
		body: JSON.stringify({ vaultId, localVaultId }),
	});
	expect(response.status).toBeLessThan(300);
	const json = (await response.json()) as { token: string };
	return json.token;
}

async function uploadBlob(
	baseUrl: string,
	token: string,
	vaultId: string,
	blobId: string,
	body: string,
): Promise<void> {
	const payload = new TextEncoder().encode(body);
	const response = await fetch(
		`${baseUrl}/v1/vaults/${vaultId}/blobs/${blobId}`,
		{
			method: "PUT",
			headers: {
				authorization: `Bearer ${token}`,
				"x-blob-size": String(payload.byteLength),
			},
			body: payload,
		},
	);
	expect(response.status).toBe(201);
}

function connectSocket(baseUrl: string, vaultId: string, token: string): Promise<WebSocket> {
	const wsUrl = `${baseUrl.replace("http://", "ws://")}/v1/vaults/${vaultId}/socket`;
	const ws = new WebSocket(wsUrl, [
		SYNC_WEBSOCKET_PROTOCOL,
		`${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token}`,
	]);
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

function nextMessage(ws: WebSocket, matching?: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 5000);
		const onMessage = (data: WebSocket.RawData) => {
			const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
			if (matching && !matching(parsed)) {
				return;
			}
			clearTimeout(timeout);
			ws.off("message", onMessage);
			resolve(parsed);
		};
		ws.on("message", onMessage);
	});
}

describe("self-hosted Node runtime: end-to-end sync", () => {
	let cleanup: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		for (const fn of cleanup.reverse()) {
			await fn();
		}
		cleanup = [];
	});

	it("serves the auth pages Cloudflare would otherwise serve via its assets binding", async () => {
		// On Cloudflare, wrangler.jsonc's "assets" binding serves apps/api/public/*
		// ahead of the Worker - the device-authorization flow's verification URI
		// (getDeviceVerificationUri -> "<baseURL>/device") and the sign-in/sign-up
		// pages depend on that. There's no equivalent outside Workers, so the Node
		// runtime has to serve these itself; this guards against that regressing.
		const { dataDir, runtime, server, wss, baseUrl } = await bootServer();
		cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
		cleanup.push(() => runtime.dispose());
		cleanup.push(() => closeServer(server, wss));

		for (const path of ["/device", "/signin", "/signup", "/vaults"]) {
			const response = await fetch(`${baseUrl}${path}`);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-type"), path).toMatch(/^text\/html/);
		}

		const robots = await fetch(`${baseUrl}/robots.txt`);
		expect(robots.status).toBe(200);
		expect(robots.headers.get("content-type")).toMatch(/^text\/plain/);

		// The auth pages fetch their shared i18n runtime and locale catalogs.
		const i18nRuntime = await fetch(`${baseUrl}/i18n.js`);
		expect(i18nRuntime.status).toBe(200);
		expect(i18nRuntime.headers.get("content-type")).toMatch(/javascript/);

		// The vaults page lazy-loads the E2EE crypto bundle for vault creation.
		// It is a tracked deployment artifact verified against the shared source in CI.
		const vaultCrypto = await fetch(`${baseUrl}/vault-crypto.js`);
		expect(vaultCrypto.status).toBe(200);
		expect(vaultCrypto.headers.get("content-type")).toMatch(/javascript/);

		for (const locale of ["ko", "ja", "zh-cn", "zh-tw", "de"]) {
			const catalog = await fetch(`${baseUrl}/i18n/${locale}.json`);
			expect(catalog.status, locale).toBe(200);
			expect(catalog.headers.get("content-type"), locale).toMatch(/^application\/json/);
		}
	});

	it("syncs a mutation between two simulated devices with no Cloudflare dependency", async () => {
		const { dataDir, runtime, server, wss, baseUrl } = await bootServer();
		cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
		cleanup.push(() => runtime.dispose());
		cleanup.push(() => closeServer(server, wss));

		const { sessionCookie, vaultId } = await signUpAndCreateVault(baseUrl);
		const tokenA = await issueSyncToken(baseUrl, sessionCookie, vaultId, "device-a");
		const tokenB = await issueSyncToken(baseUrl, sessionCookie, vaultId, "device-b");

		const deviceA = await connectSocket(baseUrl, vaultId, tokenA);
		const deviceB = await connectSocket(baseUrl, vaultId, tokenB);
		cleanup.push(() => deviceA.close());
		cleanup.push(() => deviceB.close());

		// "hello" is what provisions the vault's coordinator state
		// (VaultLifecycleService.ensureVaultState) on first contact - staging a
		// blob before any device has said hello has nothing to stage against.
		deviceA.send(JSON.stringify({ type: "hello", requestId: "hello-a", lastKnownCursor: 0 }));
		await nextMessage(deviceA, (m) => m.type === "hello_ack");
		deviceB.send(JSON.stringify({ type: "hello", requestId: "hello-b", lastKnownCursor: 0 }));
		await nextMessage(deviceB, (m) => m.type === "hello_ack");

		await uploadBlob(baseUrl, tokenA, vaultId, "blob-1", "encrypted file contents");

		const deviceBBroadcast = nextMessage(deviceB, (m) => m.type === "cursor_advanced");

		deviceA.send(
			JSON.stringify({
				type: "commit_mutations",
				requestId: "commit-1",
				mutations: [
					{
						mutationId: "mutation-1",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: "blob-1",
						encryptedMetadata: "ciphertext-from-device-a",
					},
				],
			}),
		);
		const committed = await nextMessage(deviceA, (m) => m.type === "commit_mutations_committed");
		expect(committed).toMatchObject({
			results: [{ status: "accepted", entryId: "entry-1", revision: 1 }],
		});

		await deviceBBroadcast;

		deviceB.send(
			JSON.stringify({
				type: "list_entry_states",
				requestId: "list-1",
				sinceCursor: 0,
				targetCursor: null,
				after: null,
				limit: 10,
			}),
		);
		const listed = await nextMessage(deviceB, (m) => m.type === "entry_states_listed");
		expect(listed).toMatchObject({
			entries: [
				{
					entryId: "entry-1",
					revision: 1,
					encryptedMetadata: "ciphertext-from-device-a",
				},
			],
		});
	});

	it("survives a clean process restart without losing committed data", async () => {
		const first = await bootServer();

		const { sessionCookie, vaultId } = await signUpAndCreateVault(first.baseUrl);
		const token = await issueSyncToken(first.baseUrl, sessionCookie, vaultId, "device-a");
		const device = await connectSocket(first.baseUrl, vaultId, token);

		device.send(JSON.stringify({ type: "hello", requestId: "hello", lastKnownCursor: 0 }));
		await nextMessage(device, (m) => m.type === "hello_ack");
		await uploadBlob(first.baseUrl, token, vaultId, "blob-1", "encrypted file contents");
		device.send(
			JSON.stringify({
				type: "commit_mutations",
				requestId: "commit-1",
				mutations: [
					{
						mutationId: "mutation-1",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: "blob-1",
						encryptedMetadata: "ciphertext-before-crash",
					},
				],
			}),
		);
		await nextMessage(device, (m) => m.type === "commit_mutations_committed");

		// This is a *clean* shutdown (dispose() checkpoints and closes SQLite
		// properly) - it verifies that data persists across a normal restart.
		// It deliberately does NOT cover a mid-write SIGKILL, where the WAL
		// file is left uncheckpointed and `locking_mode=EXCLUSIVE` must let a
		// fresh process recover it - see the SIGKILL test below for that.
		device.terminate();
		await closeServer(first.server, first.wss);
		first.runtime.dispose();

		// "Restart": open a brand new runtime against the same data directory,
		// as a fresh process would. The session cookie from before the crash
		// still works, since it's stored in the (also persisted) app DB.
		const second = await bootServer(first.dataDir);
		cleanup.push(() => rmSync(first.dataDir, { recursive: true, force: true }));
		cleanup.push(() => second.runtime.dispose());
		cleanup.push(() => closeServer(second.server, second.wss));

		const token2 = await issueSyncToken(second.baseUrl, sessionCookie, vaultId, "device-b");
		const device2 = await connectSocket(second.baseUrl, vaultId, token2);
		cleanup.push(() => device2.close());
		device2.send(JSON.stringify({ type: "hello", requestId: "hello", lastKnownCursor: 0 }));
		await nextMessage(device2, (m) => m.type === "hello_ack");
		device2.send(
			JSON.stringify({
				type: "list_entry_states",
				requestId: "list-1",
				sinceCursor: 0,
				targetCursor: null,
				after: null,
				limit: 10,
			}),
		);
		const listed = await nextMessage(device2, (m) => m.type === "entry_states_listed");
		expect(listed).toMatchObject({
			entries: [{ entryId: "entry-1", revision: 1, encryptedMetadata: "ciphertext-before-crash" }],
		});
	});

	it(
		"survives a SIGKILL mid-session without corrupting the SQLite backend",
		async () => {
			const dataDir = mkdtempSync(path.join(tmpdir(), "synch-self-host-e2e-sigkill-"));
			cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));

			const first = await bootSubprocessServer(dataDir);
			cleanup.push(() => killAndWaitForExit(first.child));

			const { sessionCookie, vaultId } = await signUpAndCreateVault(first.baseUrl);
			const token = await issueSyncToken(first.baseUrl, sessionCookie, vaultId, "device-a");
			const device = await connectSocket(first.baseUrl, vaultId, token);
			device.send(JSON.stringify({ type: "hello", requestId: "hello", lastKnownCursor: 0 }));
			await nextMessage(device, (m) => m.type === "hello_ack");
			await uploadBlob(first.baseUrl, token, vaultId, "blob-1", "encrypted file contents");
			device.send(
				JSON.stringify({
					type: "commit_mutations",
					requestId: "commit-1",
					mutations: [
						{
							mutationId: "mutation-1",
							entryId: "entry-1",
							op: "upsert",
							baseRevision: 0,
							blobId: "blob-1",
							encryptedMetadata: "ciphertext-before-sigkill",
						},
					],
				}),
			);
			await nextMessage(device, (m) => m.type === "commit_mutations_committed");

			// No graceful shutdown at all: the OS tears the process down mid-flight,
			// leaving whatever the SQLite WAL/lock state happened to be at that
			// instant. `locking_mode = EXCLUSIVE` must release its OS-level lock
			// when the process dies (the OS does this automatically on exit), and
			// a fresh process must be able to open the file and replay the WAL.
			device.terminate();
			await killAndWaitForExit(first.child);

			const second = await bootSubprocessServer(dataDir);
			cleanup.push(() => killAndWaitForExit(second.child));

			const token2 = await issueSyncToken(second.baseUrl, sessionCookie, vaultId, "device-b");
			const device2 = await connectSocket(second.baseUrl, vaultId, token2);
			cleanup.push(() => device2.close());
			device2.send(JSON.stringify({ type: "hello", requestId: "hello", lastKnownCursor: 0 }));
			await nextMessage(device2, (m) => m.type === "hello_ack");
			device2.send(
				JSON.stringify({
					type: "list_entry_states",
					requestId: "list-1",
					sinceCursor: 0,
					targetCursor: null,
					after: null,
					limit: 10,
				}),
			);
			const listed = await nextMessage(device2, (m) => m.type === "entry_states_listed");
			expect(listed).toMatchObject({
				entries: [{ entryId: "entry-1", revision: 1, encryptedMetadata: "ciphertext-before-sigkill" }],
			});
		},
		30_000,
	);
});
