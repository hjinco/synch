import type { ClientControlMessage } from "../../../application/dto/protocol-types";

export interface CoordinatorSocketMessageHandler {
	handle(connectionId: string, message: ClientControlMessage): Promise<void>;
	handleDisconnect(connectionId: string): void;
}
