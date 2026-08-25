import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createApiApplication } from "../composition/create-api-application";
import { NODE_COMMUNITY_PROFILE } from "../config/deployment-profile";
import { resolveNodeAsset } from "../config/node-assets";
import { createLibsqlDb } from "../db/client";
import * as schema from "../db/d1";
import type { BlobObjectStorage } from "../sync-blob-transfer/application/ports/outbound/blob-object-storage";
import { NodeCoordinatorNamespace } from "./node-coordinator-namespace";

const DEFAULT_MIGRATIONS_FOLDER = resolveNodeAsset("drizzle");

// On Cloudflare, `wrangler.jsonc`'s "assets" binding serves apps/api/public/*
// ahead of the Worker entirely. There's no equivalent outside Workers, so the
// Node runtime serves that directory itself. `html_handling: "drop-trailing-slash"`
// maps extensionless routes (e.g. /device -> device.html) that the
// device-authorization flow and the auth pages link to.
const PUBLIC_DIR = resolveNodeAsset("public");

function rewritePublicAssetPath(urlPath: string): string {
	const relative = urlPath.replace(/^\/+|\/+$/g, "");
	if (relative === "" || path.posix.extname(relative) !== "") {
		return relative;
	}
	return `${relative}.html`;
}

export interface NodeRuntimeConfig {
	dataDir: string;
	publicUrl: string;
	corsOrigin?: string;
	betterAuthSecret: string;
	authAllowedEmails: string;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	blobStorage: BlobObjectStorage;
	/** Defaults to the drizzle/*.sql folder shared with the D1 (Cloudflare) backend. */
	migrationsFolder?: string;
}

/**
 * Wires the same portable core (`createApp`, Vault composition,
 * subscription policy use cases, sync-access/blob-transfer features, ...)
 * used on Cloudflare
 * (`runtime/http.ts`), but entirely with the self-hosted backends built in
 * earlier stages: a libSQL file for the app DB, `NodeCoordinatorNamespace`
 * (one SQLite file per vault) in place of the Durable Object namespace, and
 * caller-supplied blob object storage (disk or S3-compatible) in place of R2.
 *
 * Always self-hosted: billing/Polar stays off (there's no Cloudflare Queue
 * to refresh subscription policy against, and self-hosted vaults get the
 * unlimited `self_hosted` policy tier unconditionally). Email verification is already disabled for
 * self-hosted mode by the auth feature configuration, so no mailer is needed either.
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

	const servePublicAsset = serveStatic({
		root: PUBLIC_DIR,
		rewriteRequestPath: rewritePublicAssetPath,
	});
	// Fallback only: `GET *` would also match API routes and run if a handler
	// called `next()`. `notFound` runs only when no route matched.
	application.app.notFound(async (c) => {
		if (c.req.method === "GET" || c.req.method === "HEAD") {
			const asset = await servePublicAsset(c, async () => {});
			if (asset) {
				return asset;
			}
		}
		return c.json({ error: "not_found", message: "unknown route" }, 404);
	});

	return {
		fetch: (request: Request) => application.app.fetch(request),
		coordinatorNamespace,
		syncTokenVerifier: application.syncTokenVerifier,
		dispose: () => {
			coordinatorNamespace.closeAll();
			void client.close();
		},
	};
}

export type NodeRuntime = Awaited<ReturnType<typeof createNodeRuntime>>;
