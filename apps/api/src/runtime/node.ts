import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import { createApiApplication } from "../composition/create-api-application";
import { NODE_COMMUNITY_PROFILE } from "../config/deployment-profile";
import { resolveNodeAsset } from "../config/node-assets";
import { createLibsqlDb } from "../db/client";
import * as schema from "../db/d1";
import type { BlobStorage } from "../sync/blob/storage";
import { InlineVaultPurgeQueue } from "../vault/inline-purge-queue";
import { NodeCoordinatorNamespace } from "./node-coordinator-namespace";

const DEFAULT_MIGRATIONS_FOLDER = resolveNodeAsset("drizzle");

// On Cloudflare, `wrangler.jsonc`'s "assets" binding serves apps/api/public/*
// (device.html, signin.html, ...) ahead of the Worker entirely - the Worker
// code never even sees those requests. There's no equivalent outside
// Workers, so the Node runtime needs to serve them itself, including the
// extensionless "clean URL" routes (e.g. /device -> device.html) that the
// device-authorization flow and the auth pages link to.
const PUBLIC_DIR = resolveNodeAsset("public");
const STATIC_PAGES: Record<string, string> = {
	"/device": "device.html",
	"/signin": "signin.html",
	"/signup": "signup.html",
	"/vaults": "vaults.html",
	"/robots.txt": "robots.txt",
	"/i18n.js": "i18n.js",
	"/vault-crypto.js": "vault-crypto.js",
};

/** The pages fetch their locale catalogs from /i18n/<locale>.json at runtime. */
function i18nCatalogRoutes(): Record<string, string> {
	return Object.fromEntries(
		readdirSync(path.join(PUBLIC_DIR, "i18n")).map((file) => [
			`/i18n/${file}`,
			path.join("i18n", file),
		]),
	);
}

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
	mkdirSync(config.dataDir, { recursive: true });
	const appDbPath = path.join(config.dataDir, "app.db");
	const client = createClient({ url: `file:${appDbPath}` });
	await migrateLibsql(drizzleLibsql(client, { schema }), {
		migrationsFolder: config.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
	});
	const db = createLibsqlDb(client);

	const publicOrigin = new URL(config.publicUrl).origin;
	const corsOrigin = config.corsOrigin ?? publicOrigin;

	const coordinatorNamespace = new NodeCoordinatorNamespace(config.dataDir, {
		db,
		blobStorage: config.blobStorage,
		syncTokenSecret: config.syncTokenSecret,
		profile: NODE_COMMUNITY_PROFILE,
		productIdsByPlanId: {},
	});
	const application = createApiApplication(
		{
			db,
			blobStorage: config.blobStorage,
			coordinatorNamespace,
			createVaultPurgeQueue: (consumer) => new InlineVaultPurgeQueue(consumer),
		},
		{
			profile: NODE_COMMUNITY_PROFILE,
			corsOrigin,
			auth: {
				baseURL: config.publicUrl,
				trustedOrigins: [publicOrigin, corsOrigin],
				devMode: false,
				secret: config.betterAuthSecret,
				allowedEmails: config.authAllowedEmails,
			},
			syncTokenSecret: config.syncTokenSecret,
			syncTokenTtlSeconds: config.syncTokenTtlSeconds,
			productIdsByPlanId: {},
		},
	);

	for (const [route, file] of Object.entries({ ...STATIC_PAGES, ...i18nCatalogRoutes() })) {
		application.app.get(route, serveStatic({ path: path.join(PUBLIC_DIR, file) }));
	}

	return {
		fetch: (request: Request) => application.app.fetch(request),
		coordinatorNamespace,
		syncTokenService: application.syncTokenService,
		dispose: () => {
			coordinatorNamespace.closeAll();
			void client.close();
		},
	};
}

export type NodeRuntime = Awaited<ReturnType<typeof createNodeRuntime>>;
