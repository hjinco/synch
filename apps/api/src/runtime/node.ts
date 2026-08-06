import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../app";
import { createAuth } from "../auth";
import { BillingRepository } from "../billing/repository";
import { BillingService } from "../billing/service";
import { capabilitiesFor, NODE_COMMUNITY_PROFILE } from "../config/deployment-profile";
import { createLibsqlDb } from "../db/client";
import * as schema from "../db/d1";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncService } from "../sync/access/service";
import { SyncTokenService } from "../sync/access/token-service";
import type { BlobStorage } from "../sync/blob/storage";
import { CoordinatorProxyRepository } from "../sync/coordinator/proxy-repository";
import { VaultPurgeConsumer } from "../vault/purge-consumer";
import type { VaultPurgeQueue } from "../vault/purge-queue";
import { VaultRepository } from "../vault/repository";
import { VaultService } from "../vault/service";
import { NodeCoordinatorNamespace } from "./node-coordinator-namespace";

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
);

// On Cloudflare, `wrangler.jsonc`'s "assets" binding serves apps/api/public/*
// (device.html, signin.html, ...) ahead of the Worker entirely - the Worker
// code never even sees those requests. There's no equivalent outside
// Workers, so the Node runtime needs to serve them itself, including the
// extensionless "clean URL" routes (e.g. /device -> device.html) that the
// device-authorization flow and the auth pages link to.
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const STATIC_PAGES: Record<string, string> = {
	"/device": "device.html",
	"/signin": "signin.html",
	"/signup": "signup.html",
	"/vaults": "vaults.html",
	"/robots.txt": "robots.txt",
};

export interface NodeRuntimeConfig {
	dataDir: string;
	publicUrl: string;
	corsOrigin?: string;
	betterAuthSecret: string;
	authAllowedEmails: string;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	blobStorage: BlobStorage;
	/** Defaults to the drizzle/*.sql folder shared with the D1 (Cloudflare) backend. */
	migrationsFolder?: string;
}

class InlineVaultPurgeQueue implements VaultPurgeQueue {
	constructor(private readonly vaultPurgeConsumer: VaultPurgeConsumer) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.vaultPurgeConsumer.purgeVault(vaultId);
	}
}

/**
 * Wires the same portable core (`createApp`, `VaultRepository`,
 * `SubscriptionPolicyService`, `SyncService`, ...) used on Cloudflare
 * (`runtime/http.ts`), but entirely with the self-hosted backends built in
 * earlier stages: a libSQL file for the app DB, `NodeCoordinatorNamespace`
 * (one SQLite file per vault) in place of the Durable Object namespace, and
 * caller-supplied `BlobStorage` (disk or S3-compatible) in place of R2.
 *
 * Always self-hosted: billing/Polar stays off (there's no Cloudflare Queue
 * to refresh subscription policy against, and self-hosted vaults get the
 * unlimited `self_hosted` policy tier unconditionally - see
 * `SubscriptionPolicyService`). Email verification is already disabled for
 * self-hosted mode in `auth/email.ts`, so no mailer is needed either.
 */
export async function createNodeRuntime(config: NodeRuntimeConfig) {
	const capabilities = capabilitiesFor(NODE_COMMUNITY_PROFILE);
	mkdirSync(config.dataDir, { recursive: true });
	const appDbPath = path.join(config.dataDir, "app.db");
	const client = createClient({ url: `file:${appDbPath}` });
	await migrateLibsql(drizzleLibsql(client, { schema }), {
		migrationsFolder: config.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
	});
	const db = createLibsqlDb(client);

	const publicOrigin = new URL(config.publicUrl).origin;
	const corsOrigin = config.corsOrigin ?? publicOrigin;

	const vaultRepository = new VaultRepository(db);
	const billingRepository = new BillingRepository(db);
	const subscriptionPolicyService = new SubscriptionPolicyService(true, db, {
		productIdsByPlanId: {},
	});
	const billingService = new BillingService(billingRepository, {
		publicBaseUrl: publicOrigin,
		wwwBaseUrl: corsOrigin,
	});

	const coordinatorNamespace = new NodeCoordinatorNamespace(config.dataDir, {
		db,
		blobStorage: config.blobStorage,
		syncTokenSecret: config.syncTokenSecret,
		edition: NODE_COMMUNITY_PROFILE.edition,
		polarProductIdsByPlanId: {},
	});
	const coordinatorProxyRepository = new CoordinatorProxyRepository(coordinatorNamespace);

	const auth = createAuth(db, {
		baseURL: config.publicUrl,
		trustedOrigins: [publicOrigin, corsOrigin],
		emailVerification: capabilities.emailVerification,
		devMode: false,
		secret: config.betterAuthSecret,
		allowedEmails: config.authAllowedEmails,
	});

	const syncTokenService = new SyncTokenService(config.syncTokenSecret);
	const vaultPurgeQueue = new InlineVaultPurgeQueue(
		new VaultPurgeConsumer(
			new VaultService(vaultRepository, subscriptionPolicyService),
			coordinatorProxyRepository,
		),
	);
	const vaultService = new VaultService(vaultRepository, subscriptionPolicyService, vaultPurgeQueue);
	const syncService = new SyncService(
		vaultService,
		syncTokenService,
		config.syncTokenTtlSeconds,
		coordinatorProxyRepository,
	);

	const app = createApp(
		{
			auth,
			syncService,
			vaultService,
			syncTokenService,
			blobRepository: config.blobStorage,
			coordinatorProxyRepository,
			subscriptionPolicyService,
			billingService,
		},
		{
			publicOrigin,
			corsOrigin,
			billingEnabled: false,
		},
	);

	for (const [route, file] of Object.entries(STATIC_PAGES)) {
		app.get(route, serveStatic({ path: path.join(PUBLIC_DIR, file) }));
	}

	return {
		fetch: (request: Request) => app.fetch(request),
		coordinatorNamespace,
		syncTokenService,
		dispose: () => {
			coordinatorNamespace.closeAll();
			void client.close();
		},
	};
}

export type NodeRuntime = Awaited<ReturnType<typeof createNodeRuntime>>;
