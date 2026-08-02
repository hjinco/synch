import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import { selectSyncWebSocketProtocol } from "../sync/access/token";
import type { NodeRuntime } from "./node";

const SOCKET_PATH_PATTERN = /^\/v1\/vaults\/([^/]+)\/socket$/;

function toFetchRequest(req: IncomingMessage, url: URL): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) {
			continue;
		}
		for (const entry of Array.isArray(value) ? value : [value]) {
			headers.append(key, entry);
		}
	}
	return new Request(url, { method: req.method ?? "GET", headers });
}

function toArrayBuffer(data: unknown): ArrayBuffer {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
	return new Uint8Array(buffer).buffer;
}

/**
 * Wires `/v1/vaults/:vaultId/socket` upgrades to the right vault's
 * in-process coordinator. Shared between the real CLI entrypoint
 * (`self-host.ts`) and tests that boot the runtime against an ephemeral
 * port, so both exercise the exact same upgrade path.
 */
export function createNodeWebSocketUpgradeHandler(runtime: NodeRuntime, publicUrl: string) {
	const pendingTasks = new Set<Promise<unknown>>();
	let closing = false;
	const wss = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols, request) => {
			const url = new URL(request.url ?? "/", publicUrl);
			const selected = selectSyncWebSocketProtocol(toFetchRequest(request, url));
			return selected && protocols.has(selected) ? selected : false;
		},
	});

	async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		if (closing) {
			socket.destroy();
			return;
		}
		const url = new URL(req.url ?? "/", publicUrl);
		const match = SOCKET_PATH_PATTERN.exec(url.pathname);
		if (!match) {
			socket.destroy();
			return;
		}
		const vaultId = decodeURIComponent(match[1]);
		const request = toFetchRequest(req, url);

		const coordinator = runtime.coordinatorNamespace.getOrCreateRuntime(vaultId);
		await coordinator.ready;

		let session;
		try {
			session = await coordinator.socketConnectionService.prepareSocketSession(
				request,
				vaultId,
			);
		} catch {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}

		if (closing) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (rawWs) => {
			const ws = rawWs as WsWebSocket;
			coordinator.socketGateway.registerSocket(ws, session);

			ws.on("message", (data, isBinary) => {
				const message = isBinary
					? toArrayBuffer(data)
					: (Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])).toString(
							"utf8",
						);
				track(coordinator.socketMessageHandler.handle(ws as unknown as WebSocket, message))
					.catch((error: unknown) => {
						console.error("[node-websocket] message handling failed", error);
					});
			});
			let disconnected = false;
			const onDisconnect = () => {
				if (disconnected) {
					return;
				}
				disconnected = true;
				coordinator.socketGateway.unregisterSocket(ws);
				track(coordinator.useCases.handleSocketClose()).catch((error: unknown) => {
					console.error("[node-websocket] socket close handling failed", error);
				});
			};
			ws.on("close", onDisconnect);
			ws.on("error", onDisconnect);

			track(coordinator.socketConnectionService.completeSocketOpen()).catch((error: unknown) => {
				console.error("[node-websocket] completeSocketOpen failed", error);
			});
		});
	}

	function track<T>(task: Promise<T>): Promise<T> {
		pendingTasks.add(task);
		void task.then(
			() => pendingTasks.delete(task),
			() => pendingTasks.delete(task),
		);
		return task;
	}

	async function drainPendingTasks(): Promise<void> {
		while (pendingTasks.size > 0) {
			await Promise.allSettled([...pendingTasks]);
		}
	}

	async function close(code: number, reason: string): Promise<void> {
		closing = true;
		for (const ws of wss.clients) {
			if (ws.readyState === ws.OPEN) {
				ws.close(code, reason);
			}
		}
		await new Promise<void>((resolve, reject) => {
			wss.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		await drainPendingTasks();
	}

	function terminate(): void {
		closing = true;
		for (const ws of wss.clients) {
			ws.terminate();
		}
	}

	return {
		wss,
		handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			void track(handleUpgrade(req, socket, head)).catch((error: unknown) => {
				console.error("[node-websocket] upgrade failed", error);
				socket.destroy();
			});
		},
		close,
		terminate,
	};
}
