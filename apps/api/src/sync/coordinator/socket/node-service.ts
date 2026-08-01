import type { WebSocket as WsWebSocket } from "ws";

import type {
	PolicyUpdatedMessage,
	ServerControlMessage,
	SocketSession,
	StorageStatusUpdatedMessage,
} from "../types";
import type { SocketGateway } from "../ports";

/**
 * Node equivalent of `CoordinatorSocketService`. There's no hibernation
 * concept here (this process holds every open socket in memory for as long
 * as it runs), so session storage is a plain `Map` in place of
 * `serializeAttachment`/`deserializeAttachment`, and the "all sockets for
 * this vault" registry is a `Set` in place of `ctx.getWebSockets()`.
 *
 * `openSocket()` deliberately throws: in the DO model a `Response` can carry
 * a live `WebSocket` back across the `stub.fetch()` boundary, which is how a
 * per-vault coordinator hands a socket back to the edge. There's no such
 * boundary in-process, so the Node HTTP layer never calls this - it upgrades
 * the connection itself (`ws`'s `WebSocketServer` in `noServer` mode) and
 * calls `registerSocket()` directly with the already-open socket. This method
 * exists only so the class satisfies `SocketGateway` structurally.
 */
export class NodeSocketGateway implements SocketGateway {
	private readonly sockets = new Set<WsWebSocket>();
	private readonly sessions = new Map<WsWebSocket, SocketSession>();

	async openSocket(): Promise<Response> {
		throw new Error(
			"NodeSocketGateway.openSocket is unreachable: the Node runtime upgrades sockets " +
				"directly and calls registerSocket() instead of going through this method.",
		);
	}

	/** Accepts an already-upgraded `ws` socket: attaches its session, closes any superseded connection for the same user+local-vault, and starts tracking it. */
	registerSocket(socket: WsWebSocket, session: SocketSession): void {
		this.attachSocketSession(socket as unknown as WebSocket, session);
		this.closeSupersededSockets(socket, session);
		this.sockets.add(socket);
	}

	/** For `CoordinatorHealthStore`'s socket counter, matching `ctx.getWebSockets().length` on the DO side. */
	socketCount(): number {
		return this.sockets.size;
	}

	/** Stops tracking a socket; call from the `ws` `close`/`error` handlers. */
	unregisterSocket(socket: WsWebSocket): void {
		this.sockets.delete(socket);
		this.sessions.delete(socket);
	}

	attachSocketSession(socket: WebSocket, session: SocketSession): void {
		this.sessions.set(socket as unknown as WsWebSocket, session);
	}

	readSocketSession(ws: WebSocket): SocketSession | null {
		return this.sessions.get(ws as unknown as WsWebSocket) ?? null;
	}

	sendSocketMessage(ws: WebSocket, message: ServerControlMessage): boolean {
		return this.trySend(ws as unknown as WsWebSocket, JSON.stringify(message));
	}

	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.sockets) {
			const session = this.sessions.get(socket);
			if (!session?.wantsStorageStatus) {
				continue;
			}
			this.trySend(socket, encoded);
		}
	}

	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.sockets) {
			this.trySend(socket, encoded);
		}
	}

	broadcastExcept(excluded: WebSocket, message: ServerControlMessage): void {
		const encoded = JSON.stringify(message);
		const excludedSocket = excluded as unknown as WsWebSocket;
		for (const socket of this.sockets) {
			if (socket === excludedSocket) {
				continue;
			}
			this.trySend(socket, encoded);
		}
	}

	closeAllSockets(code: number, reason: string): void {
		for (const socket of this.sockets) {
			this.closeSocket(socket, code, reason);
		}
	}

	private closeSupersededSockets(current: WsWebSocket, session: SocketSession): void {
		for (const socket of this.sockets) {
			if (socket === current) {
				continue;
			}

			const existing = this.sessions.get(socket);
			if (!existing) {
				continue;
			}

			if (
				existing.userId === session.userId &&
				existing.localVaultId === session.localVaultId
			) {
				this.trySend(
					socket,
					JSON.stringify({
						type: "session_error",
						code: "local_vault_replaced",
						message: "connection replaced by a newer sync session for this local vault",
					} satisfies ServerControlMessage),
				);
				this.closeSocket(socket, 4409, "superseded by newer connection");
			}
		}
	}

	private trySend(socket: WsWebSocket, encoded: string): boolean {
		if (socket.readyState !== socket.OPEN) {
			return false;
		}
		try {
			socket.send(encoded);
			return true;
		} catch {
			return false;
		}
	}

	private closeSocket(socket: WsWebSocket, code: number, reason: string): void {
		if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
			return;
		}
		try {
			socket.close(code, reason);
		} catch {
			// already closing/closed; nothing to do
		}
	}
}
