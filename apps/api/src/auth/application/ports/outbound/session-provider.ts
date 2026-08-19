import type {
	AuthenticatedSession,
	SessionLookup,
} from "../../dto/session";

export interface SessionProvider {
	readSession(input: SessionLookup): Promise<AuthenticatedSession | null>;
}
