import type {
	AuthenticatedSession,
	SessionLookup,
} from "../dto/session";
import type { SessionReader } from "../ports/inbound/session-reader";
import type { SessionProvider } from "../ports/outbound/session-provider";

export class ReadSessionUseCase implements SessionReader {
	constructor(private readonly sessionProvider: SessionProvider) {}

	async readSession(input: SessionLookup): Promise<AuthenticatedSession | null> {
		return await this.sessionProvider.readSession(input);
	}
}
