import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shutdownNodeServer, type NodeWebSocketShutdown } from "./node-shutdown";

describe("shutdownNodeServer", () => {
	let server: Server | null = null;

	afterEach(() => {
		server?.closeAllConnections();
		server?.close();
		server = null;
	});

	it("waits for an active HTTP request before disposing runtime storage", async () => {
		let releaseRequest: () => void = () => {};
		const requestReleased = new Promise<void>((resolve) => {
			releaseRequest = resolve;
		});
		let markRequestStarted: () => void = () => {};
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});

		server = createServer(async (_request, response) => {
			markRequestStarted();
			await requestReleased;
			response.end("done");
		});
		await listen(server);

		const responsePromise = fetch(serverUrl(server), {
			headers: { connection: "close" },
		}).then((response) => response.text());
		await requestStarted;

		const dispose = vi.fn();
		const webSockets = immediateWebSocketShutdown();
		const shutdown = shutdownNodeServer({
			server,
			webSockets,
			dispose,
			timeoutMs: 1_000,
		});

		await Promise.resolve();
		expect(dispose).not.toHaveBeenCalled();

		releaseRequest();
		expect(await responsePromise).toBe("done");
		expect(await shutdown).toEqual({ forced: false });
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("waits for WebSocket work to drain before disposing runtime storage", async () => {
		server = createServer();
		await listen(server);

		let releaseWebSockets: () => void = () => {};
		const webSocketsClosed = new Promise<void>((resolve) => {
			releaseWebSockets = resolve;
		});
		const webSockets: NodeWebSocketShutdown = {
			close: vi.fn(async () => await webSocketsClosed),
			terminate: vi.fn(),
		};
		const dispose = vi.fn();
		const shutdown = shutdownNodeServer({
			server,
			webSockets,
			dispose,
			timeoutMs: 1_000,
		});

		await Promise.resolve();
		expect(dispose).not.toHaveBeenCalled();

		releaseWebSockets();
		expect(await shutdown).toEqual({ forced: false });
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("force-closes connections after the drain timeout", async () => {
		server = createServer();
		await listen(server);

		const webSockets: NodeWebSocketShutdown = {
			close: vi.fn(() => new Promise<void>(() => {})),
			terminate: vi.fn(),
		};
		const dispose = vi.fn();
		const closeAllConnections = vi.spyOn(server, "closeAllConnections");

		const result = await shutdownNodeServer({
			server,
			webSockets,
			dispose,
			timeoutMs: 5,
			forceSettleMs: 5,
		});

		expect(result).toEqual({ forced: true });
		expect(closeAllConnections).toHaveBeenCalledOnce();
		expect(webSockets.terminate).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});

function immediateWebSocketShutdown(): NodeWebSocketShutdown {
	return {
		close: vi.fn(async () => {}),
		terminate: vi.fn(),
	};
}

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server: Server): string {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("server is not listening on a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}
