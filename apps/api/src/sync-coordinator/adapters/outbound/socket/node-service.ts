import type { WebSocket as WsWebSocket } from "ws";

import type {
	PolicyUpdatedMessage,
	PresenceAvailabilityMessage,
	PresenceClearedMessage,
	PresenceUpdatedMessage,
	ServerControlMessage,
	SocketSession,
	StorageStatusUpdatedMessage,
} from "../../../application/dto/types";
import type { SocketGateway } from "../../../application/ports/outbound";
import { shouldReplaceSocketSession } from "../../../domain/socket-policy";

type SocketRecord = { id: string; session: SocketSession };

/** Node socket adapter; application code sees only opaque connection IDs. */
export class NodeSocketGateway implements SocketGateway {
	private readonly sockets = new Map<WsWebSocket, SocketRecord>();

	async openSocket(): Promise<Response> {
		throw new Error(
			"NodeSocketGateway.openSocket is unreachable: the Node runtime upgrades sockets directly.",
		);
	}

	registerSocket(socket: WsWebSocket, session: SocketSession): string {
		const id = crypto.randomUUID();
		this.sockets.set(socket, { id, session });
		this.closeSupersededSockets(socket, session);
		return id;
	}

	socketCount(): number {
		return this.sockets.size;
	}

	connectionIdFor(socket: WsWebSocket): string | null {
		return this.sockets.get(socket)?.id ?? null;
	}

	unregisterSocket(socket: WsWebSocket): void {
		this.sockets.delete(socket);
	}

	attachSocketSession(connectionId: string, session: SocketSession): void {
		for (const record of this.sockets.values()) {
			if (record.id === connectionId) {
				record.session = session;
				return;
			}
		}
	}

	readSocketSession(connectionId: string): SocketSession | null {
		for (const record of this.sockets.values()) {
			if (record.id === connectionId) return record.session;
		}
		return null;
	}

	sendSocketMessage(connectionId: string, message: ServerControlMessage): boolean {
		const socket = this.socketFor(connectionId);
		return socket ? this.trySend(socket, JSON.stringify(message)) : false;
	}

	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const [socket, record] of this.sockets) {
			if (record.session.wantsStorageStatus) this.trySend(socket, encoded);
		}
	}

	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.sockets.keys()) this.trySend(socket, encoded);
	}

	broadcastPresenceToWatchers(
		entryId: string,
		excludedConnectionId: string,
		message: PresenceUpdatedMessage | PresenceClearedMessage,
	): void {
		const encoded = JSON.stringify(message);
		for (const [socket, record] of this.sockets) {
			if (record.id === excludedConnectionId) continue;
			if (
				record.session.wantsPresence &&
				record.session.presenceWatchEntryIds.includes(entryId)
			) {
				this.trySend(socket, encoded);
			}
		}
	}

	broadcastPresenceAvailability(excludedConnectionId?: string): boolean {
		const watchers = [...this.sockets].filter(
			([, record]) =>
				record.id !== excludedConnectionId && record.session.wantsPresence,
		);
		const enabled = watchers.length > 1;
		const encoded = JSON.stringify({
			type: "presence_availability",
			enabled,
		} satisfies PresenceAvailabilityMessage);
		for (const [socket] of watchers) {
			this.trySend(socket, encoded);
		}
		return enabled;
	}

	broadcastExcept(excludedConnectionId: string, message: ServerControlMessage): void {
		const encoded = JSON.stringify(message);
		for (const [socket, record] of this.sockets) {
			if (record.id !== excludedConnectionId) this.trySend(socket, encoded);
		}
	}

	closeSocket(connectionId: string, code: number, reason: string): void {
		const socket = this.socketFor(connectionId);
		if (socket) this.closeNativeSocket(socket, code, reason);
	}

	closeAllSockets(code: number, reason: string): void {
		for (const socket of this.sockets.keys()) this.closeNativeSocket(socket, code, reason);
	}

	private socketFor(connectionId: string): WsWebSocket | null {
		for (const [socket, record] of this.sockets) {
			if (record.id === connectionId) return socket;
		}
		return null;
	}

	private closeSupersededSockets(current: WsWebSocket, session: SocketSession): void {
		for (const [socket, record] of this.sockets) {
			if (
				socket !== current &&
				shouldReplaceSocketSession(record.session, session)
			) {
				this.sendSocketMessage(record.id, {
					type: "session_error",
					code: "local_vault_replaced",
					message: "connection replaced by a newer sync session for this local vault",
				});
				this.closeSocket(record.id, 4409, "superseded by newer connection");
			}
		}
	}

	private trySend(socket: WsWebSocket, encoded: string): boolean {
		if (socket.readyState !== socket.OPEN) return false;
		try {
			socket.send(encoded);
			return true;
		} catch {
			return false;
		}
	}

	private closeNativeSocket(socket: WsWebSocket, code: number, reason: string): void {
		if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) return;
		try {
			socket.close(code, reason);
		} catch {
			// already closing/closed
		}
	}
}
