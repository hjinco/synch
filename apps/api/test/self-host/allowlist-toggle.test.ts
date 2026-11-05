import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime, type NodeRuntime } from "../../src/runtime/node";
import { LocalDiskBlobObjectStorage } from "../../src/sync-blob-transfer/adapters/outbound/local-disk-object-storage";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_BIN = path.join(API_ROOT, "node_modules/.bin/tsx");

/** Reserves a free TCP port synchronously, mirroring test/self-host/e2e.test.ts. */
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

describe("self-hosted Node runtime: password sign-up / allowlist gating", () => {
	let cleanup: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		for (const fn of cleanup.reverse()) {
			await fn();
		}
		cleanup = [];
	});

	it("constructs the Node runtime with no AUTH_ALLOWED_EMAILS once password sign-up is disabled, and actually disables password sign-up", async () => {
		const dataDir = mkdtempSync(path.join(tmpdir(), "synch-self-host-allowlist-"));
		cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));

		let runtime: NodeRuntime | undefined;
		await expect(
			(async () => {
				runtime = await createNodeRuntime({
					dataDir,
					publicUrl: "http://127.0.0.1:8787",
					betterAuthSecret: "test-secret-test-secret-test-secret",
					authAllowedEmails: undefined,
					emailAndPassword: "disabled",
					syncTokenSecret: "test-sync-token-secret-test-sync",
					blobStorage: new LocalDiskBlobObjectStorage(path.join(dataDir, "blobs")),
				});
			})(),
		).resolves.not.toThrow();
		cleanup.push(() => runtime?.dispose());

		const health = await runtime?.fetch(new Request("http://127.0.0.1:8787/health"));
		expect(health?.status).toBe(200);

		// Proves emailAndPassword actually reached createBetterAuth rather than
		// merely being accepted as a config field: with the provider disabled,
		// sign-up must be rejected even though no allowlist gates it.
		const signUp = await runtime?.fetch(
			new Request("http://127.0.0.1:8787/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "http://127.0.0.1:8787" },
				body: JSON.stringify({
					email: "nobody@example.com",
					password: "correct horse battery staple",
					name: "Nobody",
				}),
			}),
		);
		expect(signUp?.status).toBeGreaterThanOrEqual(400);
	});

	it("fails to boot the self-host CLI without AUTH_ALLOWED_EMAILS when password sign-up is enabled (the default)", async () => {
		const dataDir = mkdtempSync(path.join(tmpdir(), "synch-self-host-allowlist-"));
		cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
		const port = await reserveFreePort();
		const baseUrl = `http://127.0.0.1:${port}`;

		const env = { ...process.env };
		delete env.AUTH_ALLOWED_EMAILS;
		delete env.AUTH_EMAIL_PASSWORD;

		const child = spawn(TSX_BIN, ["src/self-host.ts"], {
			cwd: API_ROOT,
			env: {
				...env,
				DATA_DIR: dataDir,
				PORT: String(port),
				PUBLIC_URL: baseUrl,
				BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
				SYNC_TOKEN_SECRET: "test-sync-token-secret-test-sync",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		cleanup.push(
			() =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve();
						return;
					}
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		);

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("self-host process did not exit within 10s")),
					10_000,
				);
				child.once("exit", (code, signal) => {
					clearTimeout(timeout);
					resolve({ code, signal });
				});
			},
		);

		expect(exit.code).not.toBe(0);
	});
});
