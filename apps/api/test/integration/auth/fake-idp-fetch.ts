import { onTestFinished } from "vitest";

import type { FakeIdp } from "../../helpers/fake-idp";

export type FakeIdpFetchRoutes = {
	discoveryUrl: string;
	jwksUrl: string;
	tokenUrl: string;
};

export type FailingFetchRoutes = Partial<FakeIdpFetchRoutes>;

type FailingFetchMode = "reject" | "hang";

function toRequestInfo(input: RequestInfo | URL): RequestInfo {
	return input instanceof URL ? input.toString() : input;
}

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof URL) {
		return input.toString();
	}
	if (typeof input === "string") {
		return input;
	}
	return input.url;
}

function sameEndpoint(requestedUrl: string, routeUrl: string): boolean {
	const requested = new URL(requestedUrl);
	const route = new URL(routeUrl);
	return requested.origin === route.origin && requested.pathname === route.pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Patches `globalThis.fetch` so subrequests made from inside the Worker to
 * the fake IdP's discovery/JWKS/token endpoints are served in-process, while
 * every other URL (including the request the test itself is driving) falls
 * through to the real `fetch`. This works because `@better-fetch/fetch` and
 * `jose`'s `fetchJwks`/`createRemoteJWKSet` both resolve `globalThis.fetch`
 * per call, and `@cloudflare/vitest-pool-workers`'s `main` worker shares the
 * isolate with the test file - no `vitest.config.mts` change is needed.
 *
 * Restores the original `fetch` in `onTestFinished`, per test rather than a
 * shared `afterEach`: the runtime app is reconstructed per request, so a
 * patch installed by one test must not leak into the next request within the
 * same test, let alone into a later test.
 */
export function installFakeIdpFetch(idp: FakeIdp, routes: FakeIdpFetchRoutes): void {
	const realFetch = globalThis.fetch;

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);

		if (sameEndpoint(url, routes.discoveryUrl)) {
			return jsonResponse(idp.discoveryDocument());
		}
		if (sameEndpoint(url, routes.jwksUrl)) {
			return jsonResponse(await idp.jwks());
		}
		if (sameEndpoint(url, routes.tokenUrl)) {
			const rawBody = await new Request(toRequestInfo(input), init).clone().text();
			const { status, body } = await idp.handleTokenRequest(rawBody);
			return jsonResponse(body, status);
		}

		return await realFetch(input, init);
	}) as typeof fetch;

	onTestFinished(() => {
		globalThis.fetch = realFetch;
	});
}

/**
 * Installs a `globalThis.fetch` patch that fails every request to the given
 * fake-IdP endpoints, so tests can exercise what happens while the identity
 * provider is unreachable. `mode: "reject"` fails immediately, modelling a
 * refused connection; `mode: "hang"` never resolves, modelling a provider that
 * accepts the connection but never answers. The distinction matters because a
 * refusal fails fast while a hang is bounded by nothing the application sets.
 * Restored in `onTestFinished`, same as `installFakeIdpFetch`.
 */
export function installFailingFetch(
	routes: FailingFetchRoutes,
	mode: FailingFetchMode = "reject",
): void {
	const realFetch = globalThis.fetch;
	const targets = [routes.discoveryUrl, routes.jwksUrl, routes.tokenUrl].filter(
		(candidate): candidate is string => Boolean(candidate),
	);

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);

		if (targets.some((target) => sameEndpoint(url, target))) {
			if (mode === "hang") {
				return await new Promise<Response>(() => {
					// Deliberately never resolves/rejects - simulates a hung IdP.
				});
			}
			throw new TypeError(`fake IdP outage: simulated network failure for ${url}`);
		}

		return await realFetch(input, init);
	}) as typeof fetch;

	onTestFinished(() => {
		globalThis.fetch = realFetch;
	});
}
