import { SYNC_WEBSOCKET_PROTOCOL } from "../../../../sync-access/application";
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

type SocketAttachment = SocketSession & { connectionId: string };

/** Durable Object socket adapter. Application code addresses sockets by opaque IDs. */
export class CoordinatorSocketService implements SocketGateway {
	private readonly connectionIds = new WeakMap<WebSocket, string>();

	constructor(private readonly ctx: DurableObjectState) {}

	async openSocket(request: Request, socketSession: SocketSession): Promise<Response> {
		const selectedProtocol = selectSyncWebSocketProtocol(request);
		const socketPair = new WebSocketPair();
		const client = socketPair[0];
		const server = socketPair[1];
		this.acceptWebSocket(server);
		const connectionId = this.connectionIdFor(server);
		this.attachSocketSession(connectionId, socketSession);
		this.closeSupersededSockets(server, socketSession);
		return new Response(null, {
			status: 101,
			headers: selectedProtocol ? { "Sec-WebSocket-Protocol": selectedProtocol } : undefined,
			webSocket: client,
		});
	}

	connectionIdFor(socket: WebSocket): string {
		const existing = this.connectionIds.get(socket);
		if (existing) return existing;
		const attachment = readSerializedAttachment(socket);
		if (
			attachment &&
			typeof attachment === "object" &&
			"connectionId" in attachment &&
			typeof attachment.connectionId === "string"
		) {
			this.connectionIds.set(socket, attachment.connectionId);
			return attachment.connectionId;
		}
		const connectionId = crypto.randomUUID();
		this.connectionIds.set(socket, connectionId);
		return connectionId;
	}

	acceptWebSocket(socket: WebSocket): void {
		this.ctx.acceptWebSocket(socket);
	}

	attachSocketSession(connectionId: string, session: SocketSession): void {
		const socket = this.findSocket(connectionId);
		if (!socket) return;
		socket.serializeAttachment({ ...session, connectionId } satisfies SocketAttachment);
	}

	sendSocketMessage(connectionId: string, message: ServerControlMessage): boolean {
		const socket = this.findSocket(connectionId);
		return socket ? this.trySend(socket, JSON.stringify(message)) : false;
	}

	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			const session = this.readSocketSession(this.connectionIdFor(socket));
			if (session?.wantsStorageStatus) this.trySend(socket, encoded);
		}
	}

	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) this.trySend(socket, encoded);
	}

	broadcastPresenceToWatchers(
		entryId: string,
		excludedConnectionId: string,
		message: PresenceUpdatedMessage | PresenceClearedMessage,
	): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			const connectionId = this.connectionIdFor(socket);
			if (connectionId === excludedConnectionId) continue;
			const session = connectionId
				? this.readSocketSession(connectionId)
				: null;
			if (session?.wantsPresence && session.presenceWatchEntryIds.includes(entryId)) {
				this.trySend(socket, encoded);
			}
		}
	}

	broadcastPresenceAvailability(excludedConnectionId?: string): boolean {
		const watchers: WebSocket[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const connectionId = this.connectionIdFor(socket);
			if (connectionId === excludedConnectionId || !connectionId) continue;
			const session = this.readSocketSession(connectionId);
			if (session?.wantsPresence) watchers.push(socket);
		}
		const enabled = watchers.length > 1;
		const encoded = JSON.stringify({
			type: "presence_availability",
			enabled,
		} satisfies PresenceAvailabilityMessage);
		for (const socket of watchers) this.trySend(socket, encoded);
		return enabled;
	}

	broadcastExcept(excludedConnectionId: string, message: ServerControlMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			if (this.connectionIdFor(socket) !== excludedConnectionId) this.trySend(socket, encoded);
		}
	}

	closeSocket(connectionId: string, code: number, reason: string): void {
		const socket = this.findSocket(connectionId);
		if (socket) this.closeNativeSocket(socket, code, reason);
	}

	closeAllSockets(code: number, reason: string): void {
		for (const socket of this.ctx.getWebSockets()) this.closeNativeSocket(socket, code, reason);
	}

	closeSupersededSockets(current: WebSocket, session: SocketSession): void {
		const currentConnectionId = this.connectionIdFor(current);
		for (const socket of this.ctx.getWebSockets()) {
			const connectionId = this.connectionIdFor(socket);
			if (socket === current || connectionId === currentConnectionId) continue;
			const existing = this.readSocketSessionFromSocket(socket, connectionId);
			if (existing && shouldReplaceSocketSession(existing, session)) {
				this.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "local_vault_replaced",
					message: "connection replaced by a newer sync session for this local vault",
				});
				this.closeSocket(connectionId, 4409, "superseded by newer connection");
			}
		}
	}

	readSocketSession(connectionId: string): SocketSession | null {
		const socket = this.findSocket(connectionId);
		if (!socket) return null;
		return this.readSocketSessionFromSocket(socket, connectionId);
	}

	private readSocketSessionFromSocket(
		socket: WebSocket,
		connectionId: string,
	): SocketSession | null {
		const attachment = readSerializedAttachment(socket);
		if (!attachment || typeof attachment !== "object") return null;
		const maybeSession = attachment as Partial<SocketAttachment>;
		if (
			(maybeSession.connectionId !== undefined && maybeSession.connectionId !== connectionId) ||
			typeof maybeSession.userId !== "string" ||
			typeof maybeSession.localVaultId !== "string" ||
			typeof maybeSession.vaultId !== "string"
		) return null;
			return {
				userId: maybeSession.userId,
				localVaultId: maybeSession.localVaultId,
				vaultId: maybeSession.vaultId,
				displayName: typeof maybeSession.displayName === "string" ? maybeSession.displayName : "",
				wantsStorageStatus: maybeSession.wantsStorageStatus === true,
				wantsPresence: maybeSession.wantsPresence === true,
				presenceEntryId:
					typeof maybeSession.presenceEntryId === "string"
						? maybeSession.presenceEntryId
						: null,
				presenceWatchEntryIds: Array.isArray(maybeSession.presenceWatchEntryIds)
					? maybeSession.presenceWatchEntryIds.filter(
							(entryId): entryId is string =>
								typeof entryId === "string" && entryId.trim().length > 0,
						)
					: [],
			};
		}

	private findSocket(connectionId: string): WebSocket | null {
		for (const socket of this.ctx.getWebSockets()) {
			if (this.connectionIdFor(socket) === connectionId) return socket;
		}
		return null;
	}

	private trySend(socket: WebSocket, encoded: string): boolean {
		if (socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(encoded);
			return true;
		} catch (error) {
			if (isClosedWebSocketSendError(error)) return false;
			throw error;
		}
	}

	private closeNativeSocket(socket: WebSocket, code: number, reason: string): void {
		if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
		try {
			socket.close(code, reason);
		} catch (error) {
			if (!isClosedWebSocketCloseError(error)) throw error;
		}
	}
}

function readSerializedAttachment(socket: WebSocket): unknown {
	return socket.deserializeAttachment() as unknown;
}

function selectSyncWebSocketProtocol(request: Request): string | null {
	const header = request.headers.get("sec-websocket-protocol");
	return header?.split(",").map((value) => value.trim()).includes(SYNC_WEBSOCKET_PROTOCOL)
		? SYNC_WEBSOCKET_PROTOCOL
		: null;
}

function isClosedWebSocketSendError(error: unknown): boolean {
	return error instanceof TypeError && /after close|closed|closing/i.test(error.message);
}

function isClosedWebSocketCloseError(error: unknown): boolean {
	return error instanceof TypeError && /already.*closed|closed|closing/i.test(error.message);
}
