import type { AppDb } from "../../db/client";
import {
	createBetterAuth,
	type AuthFeatureConfig,
	type AuthPlugin,
	type BetterAuth,
	type BetterAuthConfig,
	type OidcAvailability,
} from "../../auth/better-auth";
import { decideTimeWindowedAction, type TimeWindowGateState } from "../../auth/oidc-diagnostics";
import type { AuthHttpHandler } from "../../auth/routes";
import {
	createBetterAuthSessionReader,
	type SessionReader,
} from "../../auth/session";

const OIDC_REBUILD_COOLDOWN_KEY = "oidc-rebuild";

/**
 * Rebuilding re-runs the OIDC plugin's `init`, which re-fetches discovery --
 * a network call with no timeout -- and re-emits better-auth's own (un-
 * de-duplicated) init-failure log lines. Without a cooldown, every request
 * that lands while the provider is unregistered triggers a fresh rebuild, so
 * both of those costs scale linearly with request volume for the entire
 * outage. This bounds rebuild attempts to at most one per window regardless
 * of traffic, the same way `OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS` bounds log
 * volume.
 *
 * Kept short (rather than the diagnostic window's generous hour, or a
 * bounded-attempt give-up like LXD's) because this policy never stops
 * retrying -- caching the failure forever was the original defect, so an
 * eventual give-up would just reintroduce it in a new shape. Unbounded-but-
 * fixed only avoids going quiet on a permanently misconfigured provider
 * (oauth2-proxy's objection to unbounded retry) because it never has to
 * carry that signal on its own: the diagnostic re-emits on its own hourly
 * cadence regardless of how often a rebuild is attempted, so a permanent
 * misconfiguration is never silent even though the rebuild attempts
 * themselves are throttled far more tightly.
 */
export const OIDC_REBUILD_COOLDOWN_MS = 2_000;

export type AuthFeature = {
	authHttpHandler: AuthHttpHandler;
	sessionReader: SessionReader;
};

type AuthInstance = {
	auth: BetterAuth;
	oidcAvailability: OidcAvailability;
};

export function createAuthFeature(
	db: AppDb,
	config: AuthFeatureConfig,
	plugins: AuthPlugin[] = [],
): AuthFeature {
	const authConfig: BetterAuthConfig = { ...config, plugins };
	let contextRejected = false;
	let rebuildCooldownState: TimeWindowGateState = new Map();

	function buildAuth(): AuthInstance {
		const oidcAvailability: OidcAvailability = { available: true };
		const auth = createBetterAuth(db, authConfig, oidcAvailability);
		// Defense in depth for construction-time failures unrelated to OIDC
		// (e.g. a plugin other than generic-oauth throwing during init): the
		// OIDC-specific isolation in `createBetterAuth` cannot catch those, so
		// this is purely bookkeeping for `currentAuth` below, not a
		// diagnostic -- `createBetterAuth` already attaches its own bounded,
		// de-duplicated logging for OIDC failures, and a promise can carry
		// any number of independent `.catch()` handlers, so this adds no
		// second log path.
		auth.$context.catch(() => {
			contextRejected = true;
		});
		return { auth, oidcAvailability };
	}

	let current = buildAuth();

	// On the Node runtime, which builds this feature once at boot, an
	// identity provider that was unreachable during OIDC discovery would
	// otherwise leave that provider permanently unregistered -- OIDC
	// discovery only ever runs once, at construction, and nothing here would
	// otherwise ask it to run again. Rebuilding on next use, instead of
	// caching the failure forever, lets a since-recovered provider start
	// working again without a restart. `contextRejected` covers the same
	// rebuild for any other construction-time failure that isn't isolated to
	// OIDC. On Cloudflare Workers this whole feature is rebuilt fresh per
	// request already, so neither flag has a realistic chance to be observed
	// true before the instance is discarded -- this is a no-op there.
	function currentAuth(): AuthInstance {
		const needsRebuild = contextRejected || !current.oidcAvailability.available;
		if (!needsRebuild) {
			return current;
		}

		// While unregistered, every request that reaches here wants a
		// rebuild -- the cooldown is what keeps that from becoming a rebuild
		// (and therefore a discovery fetch, and a pair of un-de-duplicated
		// log lines) on every single one of them. Serving the still-
		// unavailable `current` instance directly when the cooldown hasn't
		// elapsed is exactly the trade-off: staler by up to the cooldown
		// window, but bounded rather than linear in traffic.
		const decision = decideTimeWindowedAction(
			rebuildCooldownState,
			OIDC_REBUILD_COOLDOWN_KEY,
			Date.now(),
			OIDC_REBUILD_COOLDOWN_MS,
		);
		rebuildCooldownState = decision.nextState;
		if (!decision.allowed) {
			return current;
		}

		current = buildAuth();
		contextRejected = false;
		return current;
	}

	return {
		authHttpHandler: (request) => {
			// Synch's endpoints enforce vault assignments, plan limits and revocation.
			// Internal Better Auth API calls (e.g. personal organization creation) remain available.
			let pathname: string;
			try {
				pathname = decodeURIComponent(new URL(request.url).pathname);
			} catch {
				return Promise.resolve(Response.json({ error: "invalid_path" }, { status: 400 }));
			}
			if (request.method === "GET" && pathname === "/api/auth/providers") {
				// Reads `current` rather than `currentAuth()`: a rebuild starts out
				// optimistically available, which would hide an ongoing OIDC outage.
				// Fields are listed explicitly because the OIDC config also carries
				// client credentials that must never reach this public response.
				const { auth, oidcAvailability } = current;
				return Promise.resolve(Response.json(
					{
						google: Boolean(auth.options.socialProviders.google),
						github: Boolean(auth.options.socialProviders.github),
						emailAndPassword: authConfig.emailAndPassword !== "disabled",
						oidc:
							authConfig.oidc && oidcAvailability.available
								? { providerId: authConfig.oidc.providerId, name: authConfig.oidc.displayName }
								: null,
					},
					{ headers: { "Cache-Control": "no-store" } },
				));
			}
			if (pathname.startsWith("/api/auth/organization/") && !(request.method === "GET" && pathname === "/api/auth/organization/list")) {
				return Promise.resolve(Response.json({ error: "use_organization_api", message: "Use the Synch organization management API" }, { status: 403 }));
			}
			return currentAuth().auth.handler(request);
		},
		sessionReader: createBetterAuthSessionReader(() => currentAuth().auth),
	};
}
