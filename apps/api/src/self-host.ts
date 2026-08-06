import { serve } from "@hono/node-server";
import type { Server as NodeHttpServer } from "node:http";

import { parseNodeServerConfig, type NodeBlobConfig } from "./config/node";
import { createNodeWebSocketUpgradeHandler } from "./runtime/node-websocket";
import { shutdownNodeServer } from "./runtime/node-shutdown";
import { LocalDiskBlobStorage } from "./sync/blob/local-disk-storage";
import { S3BlobStorage } from "./sync/blob/s3-storage";
import type { BlobStorage } from "./sync/blob/storage";
import { createNodeRuntime } from "./runtime/node";

function createBlobStorage(config: NodeBlobConfig): BlobStorage {
	if (config.kind === "s3") {
		return new S3BlobStorage({
			endpoint: config.endpoint,
			bucket: config.bucket,
			region: config.region,
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		});
	}
	return new LocalDiskBlobStorage(config.directory);
}

async function main(): Promise<void> {
	const config = parseNodeServerConfig(process.env);
	// Defaults to all interfaces (needed for Docker's port publishing to work
	// at all - binding to 127.0.0.1 inside a container makes it unreachable
	// from outside its own network namespace). Set HOST=127.0.0.1 for a
	// bare-metal/systemd deployment that's only ever reached through a local
	// reverse proxy (e.g. `tailscale serve`, nginx, Caddy).
	const runtime = await createNodeRuntime({
		dataDir: config.dataDir,
		publicUrl: config.publicUrl,
		corsOrigin: config.corsOrigin,
		betterAuthSecret: config.betterAuthSecret,
		authAllowedEmails: config.authAllowedEmails,
		syncTokenSecret: config.syncTokenSecret,
		syncTokenTtlSeconds: config.syncTokenTtlSeconds,
		blobStorage: createBlobStorage(config.blob),
	});

	const webSockets = createNodeWebSocketUpgradeHandler(runtime, config.publicUrl);
	// Without a custom createServer option, @hono/node-server always creates an HTTP/1 server.
	const server = serve({
		fetch: (request) => runtime.fetch(request),
		port: config.port,
		hostname: config.host,
	}) as NodeHttpServer;
	server.on("upgrade", webSockets.handleUpgrade);

	console.log(
		`[self-host] listening on ${config.host}:${config.port}, data dir ${config.dataDir}`,
	);

	let shutdownPromise: Promise<void> | null = null;
	const shutdown = (signal: NodeJS.Signals) => {
		if (shutdownPromise) {
			return;
		}

		console.log(`[self-host] received ${signal}, draining active requests`);
		shutdownPromise = shutdownNodeServer({
			server,
			webSockets,
			dispose: runtime.dispose,
		})
			.then((result) => {
				if (result.forced) {
					console.error(
						"[self-host] graceful shutdown timed out; remaining connections were terminated",
						result.error,
					);
				}
				process.exitCode = result.error ? 1 : 0;
			})
			.catch((error: unknown) => {
				console.error("[self-host] shutdown failed", error);
				process.exitCode = 1;
			});
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
	console.error("[self-host] failed to start", error);
	process.exit(1);
});
