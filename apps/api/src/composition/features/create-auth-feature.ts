import type { AppDb } from "../../db/client";
import {
	createBetterAuth,
	type AuthFeatureConfig,
	type AuthPlugin,
} from "../../auth/better-auth";
import { createOidcAuth, OIDC_RETRY_COOLDOWN_MS } from "../../auth/oidc-auth";
import { isOidcRequest } from "../../auth/oidc-request";
import type { AuthHttpHandler } from "../../auth/routes";
import { createBetterAuthSessionReader, type SessionReader } from "../../auth/session";

export type AuthFeature = {
	authHttpHandler: AuthHttpHandler;
	sessionReader: SessionReader;
};

export function createAuthFeature(
	db: AppDb,
	config: AuthFeatureConfig,
	plugins: AuthPlugin[] = [],
): AuthFeature {
	// Both contexts share the database, secret, cookies and session policy.
	// Only explicit provider operations need discovery; local authentication
	// remains usable even when the IdP accepts a connection but never responds.
	const auth = createBetterAuth(db, { ...config, oidc: undefined, plugins });
	const oidcAuth = config.oidc
		? createOidcAuth(() => createBetterAuth(db, { ...config, plugins }), config.oidc)
		: undefined;

	return {
		authHttpHandler: async (request) => {
			let pathname: string;
			try {
				pathname = decodeURIComponent(new URL(request.url).pathname);
			} catch {
				return Response.json({ error: "invalid_path" }, { status: 400 });
			}
			if (request.method === "GET" && pathname === "/api/auth/providers") {
				// Advertise configuration, not transient network availability. The
				// button must remain available to retry after an IdP outage.
				return Response.json({
					google: Boolean(auth.options.socialProviders.google),
					github: Boolean(auth.options.socialProviders.github),
					emailAndPassword: config.emailAndPassword !== "disabled",
					oidc: config.oidc
						? { providerId: config.oidc.providerId, name: config.oidc.displayName }
						: null,
				}, { headers: { "Cache-Control": "no-store" } });
			}
			// Synch's own endpoints enforce vault assignments, limits and revocation.
			if (pathname.startsWith("/api/auth/organization/") && !(request.method === "GET" && pathname === "/api/auth/organization/list")) {
				return Response.json({ error: "use_organization_api", message: "Use the Synch organization management API" }, { status: 403 });
			}
			if (oidcAuth && await isOidcRequest(request, pathname, async (accountId) => {
				// Use Better Auth's authenticated account list so routing cannot look
				// up another user's account. The HTTP handler also applies bearer auth.
				const url = new URL("/api/auth/list-accounts", request.url);
				const response = await auth.handler(new Request(url, { headers: request.headers }));
				if (!response.ok) return undefined;
				const accounts = await response.json<Array<{ id: string; providerId: string }>>();
				return accounts.find((account) => account.id === accountId)?.providerId;
			})) {
				const ready = await oidcAuth.get();
				if (!ready) {
					return Response.json({ code: "OIDC_UNAVAILABLE", message: "Single sign-on is temporarily unavailable. Please try again." }, {
						status: 503,
						headers: { "Retry-After": String(OIDC_RETRY_COOLDOWN_MS / 1_000), "Cache-Control": "no-store" },
					});
				}
				return ready.handler(request);
			}
			return (oidcAuth?.peek() ?? auth).handler(request);
		},
		sessionReader: createBetterAuthSessionReader(auth),
	};
}
