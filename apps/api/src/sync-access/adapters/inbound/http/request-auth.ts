import type { VerifySyncToken } from "../../../application/ports/inbound/verify-sync-token";
import {
	parseBearerToken,
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
} from "../../../application/dto/token";

export function readSyncTokenFromRequest(request: Request): string | null {
	const bearerToken = parseBearerToken(request.headers.get("authorization"));
	if (bearerToken) {
		return bearerToken;
	}

	for (const protocol of readRequestedWebSocketProtocols(request)) {
		if (protocol.startsWith(SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX)) {
			const token = protocol.slice(SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX.length);
			if (token) {
				return token;
			}
		}
	}

	return null;
}

export function selectSyncWebSocketProtocol(request: Request): string | null {
	const protocols = readRequestedWebSocketProtocols(request);
	return protocols.includes("synch.v1") ? "synch.v1" : null;
}

export function createRequestTokenVerifier(verifier: VerifySyncToken) {
	return {
		requireSyncToken: (request: Request, expectedVaultId?: string) =>
			verifier.verifySyncToken(readSyncTokenFromRequest(request), expectedVaultId),
	};
}

function readRequestedWebSocketProtocols(request: Request): string[] {
	const header = request.headers.get("sec-websocket-protocol");
	if (!header) {
		return [];
	}

	return header
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}
