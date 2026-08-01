import { serve } from "@hono/node-server";

import { createNodeWebSocketUpgradeHandler } from "./runtime/node-websocket";
import { LocalDiskBlobStorage } from "./sync/blob/local-disk-storage";
import { S3BlobStorage } from "./sync/blob/s3-storage";
import type { BlobStorage } from "./sync/blob/storage";
import { createNodeRuntime } from "./runtime/node";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value || !value.trim()) {
		throw new Error(`${name} environment variable is required`);
	}
	return value;
}

function readBlobStorage(dataDir: string): BlobStorage {
	const kind = (process.env.BLOB_STORAGE ?? "disk").toLowerCase();
	if (kind === "s3") {
		return new S3BlobStorage({
			endpoint: requireEnv("S3_ENDPOINT"),
			bucket: requireEnv("S3_BUCKET"),
			region: process.env.S3_REGION,
			accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
			secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
		});
	}
	if (kind !== "disk") {
		throw new Error(`BLOB_STORAGE must be "disk" or "s3", got: ${kind}`);
	}
	return new LocalDiskBlobStorage(process.env.BLOB_DISK_DIR ?? `${dataDir}/blobs`);
}

async function main(): Promise<void> {
	const dataDir = process.env.DATA_DIR ?? "./data";
	const port = Number(process.env.PORT ?? 8787);
	// Defaults to all interfaces (needed for Docker's port publishing to work
	// at all - binding to 127.0.0.1 inside a container makes it unreachable
	// from outside its own network namespace). Set HOST=127.0.0.1 for a
	// bare-metal/systemd deployment that's only ever reached through a local
	// reverse proxy (e.g. `tailscale serve`, nginx, Caddy).
	const host = process.env.HOST ?? "0.0.0.0";
	const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

	const runtime = await createNodeRuntime({
		dataDir,
		publicUrl,
		corsOrigin: process.env.CORS_ORIGIN,
		betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
		syncTokenSecret: requireEnv("SYNC_TOKEN_SECRET"),
		syncTokenTtlSeconds: process.env.SYNC_TOKEN_TTL_SECONDS
			? Number(process.env.SYNC_TOKEN_TTL_SECONDS)
			: undefined,
		blobStorage: readBlobStorage(dataDir),
	});

	const { wss, handleUpgrade } = createNodeWebSocketUpgradeHandler(runtime, publicUrl);
	const server = serve({ fetch: (request) => runtime.fetch(request), port, hostname: host });
	server.on("upgrade", handleUpgrade);

	console.log(`[self-host] listening on ${host}:${port}, data dir ${dataDir}`);

	const shutdown = () => {
		console.log("[self-host] shutting down");
		wss.close();
		server.close();
		runtime.dispose();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	console.error("[self-host] failed to start", error);
	process.exit(1);
});
