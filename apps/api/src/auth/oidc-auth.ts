import type { BetterAuth } from "./better-auth";
import { recordOidcDiagnostic, shouldEmitOidcDiagnostic } from "./oidc-diagnostics";
import type { OidcProviderConfig } from "./policies/oidc";

export const OIDC_INIT_WAIT_MS = 3_000;
export const OIDC_RETRY_COOLDOWN_MS = 2_000;

type Attempt = {
	auth: BetterAuth;
	result: Promise<BetterAuth | null>;
	settled: boolean;
	ready: boolean;
	retryAt: number;
};

/**
 * Discovery belongs to OIDC requests, never the shared session/password context.
 * Keep a single in-flight attempt on Node, including after the caller's deadline:
 * genericOAuth does not expose an AbortSignal for discovery. Discarding that
 * attempt and rebuilding would accumulate live fetches during a prolonged stall.
 * A late success remains usable; a settled failure can retry after the cooldown.
 * Workers create this accessor per request, without sharing request-bound I/O.
 */
export function createOidcAuth(
	build: () => BetterAuth,
	oidc: OidcProviderConfig,
) {
	let current: Attempt | undefined;

	function diagnose(errorClass: string) {
		const key = `${oidc.providerId}:${oidc.discoveryUrl}:${errorClass}`;
		if (shouldEmitOidcDiagnostic(key)) {
			recordOidcDiagnostic(key, { providerId: oidc.providerId, errorClass });
		}
	}

	function start(): Attempt {
		const auth = build();
		const attempt: Attempt = {
			auth,
			result: Promise.resolve(null),
			settled: false,
			ready: false,
			retryAt: 0,
		};
		let timer: ReturnType<typeof setTimeout>;
		const ready = auth.$context.then(
			() => {
				attempt.settled = true;
				attempt.ready = true;
				return auth;
			},
			() => {
				attempt.settled = true;
				attempt.retryAt = Date.now() + OIDC_RETRY_COOLDOWN_MS;
				diagnose("initialization-failed");
				return null;
			},
		);
		const deadline = new Promise<null>((resolve) => {
			timer = setTimeout(() => {
				diagnose("initialization-timeout");
				resolve(null);
			}, OIDC_INIT_WAIT_MS);
		});
		attempt.result = Promise.race([ready, deadline]).finally(() => clearTimeout(timer));
		return attempt;
	}

	return {
		async get(): Promise<BetterAuth | null> {
			if (!current || (current.settled && !current.ready && Date.now() >= current.retryAt)) {
				current = start();
			}
			return current.ready ? current.auth : current.result;
		},
		// Once initialized, the richer context is safe to use without waiting
		// (including Better Auth's optional provider logout on Node).
		peek(): BetterAuth | undefined {
			return current?.ready ? current.auth : undefined;
		},
	};
}
