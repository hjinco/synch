import type {
	AuthenticatedSession,
	SessionLookup,
} from "../../dto/session";

export interface SessionReader {
	readSession(input: SessionLookup): Promise<AuthenticatedSession | null>;
}
