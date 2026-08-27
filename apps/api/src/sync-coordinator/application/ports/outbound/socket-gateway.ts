import type {
	PolicyUpdatedMessage,
	PresenceClearedMessage,
	PresenceUpdatedMessage,
	ServerControlMessage,
	SocketSession,
	StorageStatusUpdatedMessage,
} from "../../dto/types";

export interface SocketGateway {
	readSocketSession(connectionId: string): SocketSession | null;
	attachSocketSession(connectionId: string, session: SocketSession): void;
	sendSocketMessage(connectionId: string, message: ServerControlMessage): boolean;
	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void;
	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void;
	broadcastPresenceToWatchers(
		entryId: string,
		excludedConnectionId: string,
		message: PresenceUpdatedMessage | PresenceClearedMessage,
	): void;
	broadcastPresenceAvailability(excludedConnectionId?: string): boolean;
	broadcastExcept(excludedConnectionId: string, message: ServerControlMessage): void;
	closeSocket(connectionId: string, code: number, reason: string): void;
	closeAllSockets(code: number, reason: string): void;
}
