import type { BetterAuth } from "./better-auth";

export type AuthenticatedUser = {
	id: string;
	email: string;
	name: string;
};

export type AuthenticatedSession = {
	user: AuthenticatedUser;
	session: {
		activeOrganizationId: string | null;
	};
};

export type SessionLookup = {
	url: URL;
	authorization?: string;
	cookie?: string;
};

export interface SessionReader {
	readSession(input: SessionLookup): Promise<AuthenticatedSession | null>;
}

export function createBetterAuthSessionReader(auth: BetterAuth): SessionReader {
	return {
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
				const response = await auth.handler(
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

			return toAuthenticatedSession(await auth.api.getSession({ headers }));
		},
	};
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
			name: typeof data.user.name === "string" ? data.user.name : "",
		},
		session: {
			activeOrganizationId: data.session?.activeOrganizationId ?? null,
		},
	};
}

export function displayNameFromAuthenticatedUser(user: AuthenticatedUser): string {
	const name = user.name.trim();
	return name || user.email.trim();
}
