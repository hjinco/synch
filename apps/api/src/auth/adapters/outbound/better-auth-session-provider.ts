import type {
	AuthenticatedSession,
	SessionLookup,
} from "../../application/dto/session";
import type { SessionProvider } from "../../application/ports/outbound/session-provider";
import type { BetterAuth } from "./better-auth";

export class BetterAuthSessionProvider implements SessionProvider {
	constructor(private readonly auth: BetterAuth) {}

	async readSession(input: SessionLookup): Promise<AuthenticatedSession | null> {
		const headers = new Headers();
		if (input.authorization) {
			headers.set("authorization", input.authorization);
		}
		if (input.cookie) {
			headers.set("cookie", input.cookie);
		}

		if (isBearerSession(headers)) {
			headers.delete("cookie");
			const url = new URL("/api/auth/get-session", input.url);
			const response = await this.auth.handler(
				new Request(url.toString(), {
					method: "GET",
					headers,
				}),
			);
			if (!response.ok) {
				return null;
			}

			return toAuthenticatedSession(
				await response.json<Awaited<ReturnType<BetterAuth["api"]["getSession"]>>>(),
			);
		}

		return toAuthenticatedSession(await this.auth.api.getSession({ headers }));
	}
}

function isBearerSession(headers: Headers): boolean {
	return headers.get("authorization")?.trim().toLowerCase().startsWith("bearer ") ?? false;
}

function toAuthenticatedSession(
	data: Awaited<ReturnType<BetterAuth["api"]["getSession"]>>,
): AuthenticatedSession | null {
	if (!data?.user) {
		return null;
	}

	return {
		user: {
			id: data.user.id,
			email: data.user.email,
		},
		session: {
			activeOrganizationId: data.session?.activeOrganizationId ?? null,
		},
	};
}
