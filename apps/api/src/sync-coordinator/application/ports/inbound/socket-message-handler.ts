import type { ClientControlMessage } from "../../dto/protocol-types";

export interface CoordinatorSocketMessageHandler {
	handle(connectionId: string, message: ClientControlMessage): Promise<void>;
}
