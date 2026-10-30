import { describe, expect, it } from "vitest";

import {
	MissingOidcVariablesError,
	type OidcProviderConfig,
} from "../auth/policies/oidc";
import { type CloudflareRuntimeEnv, parseCloudflareHttpConfig } from "./cloudflare";
import { parseNodeServerConfig } from "./node";

// OIDC config is hand-maintained twice: once as a zod schema (Node/self-host)
// and once as a TypeScript binding type (Cloudflare Workers). Nothing forces
// the two to recognize the same environment variable names, so it is easy for
// one runtime to gain a variable the other silently ignores -- or for the same
// setting to end up under two spellings. Either way an operator sets the
// documented variable, one runtime honours it, the other falls back to a
// default, and no error is surfaced anywhere. Self-hosting is the primary
// audience for OIDC here, so that silence is the worst part.
//
// This file exists to turn that class of divergence into a failing test rather
// than something a reviewer has to spot by reading both config files at once.
//
// The variable names below are the single place this file lists them. Both
// the equality check and the divergence probe read from this one object
// instead of each keeping its own copy, because two hand-kept lists is the
// same failure mode this file is guarding against.
const oidcAndAuthVariables = {
	OIDC_DISCOVERY_URL: "https://idp.example.com/oidc",
	OIDC_CLIENT_ID: "test-client-id",
	OIDC_CLIENT_SECRET: "test-client-secret",
	OIDC_PROVIDER_NAME: "Acme SSO",
	OIDC_SCOPES: "openid,profile",
	OIDC_ACCOUNT_ISSUER: "https://issuer.example.com",
	AUTH_EMAIL_PASSWORD: "disabled",
} as const;

const CANONICAL_VARIABLE_NAMES = Object.keys(
	oidcAndAuthVariables,
) as Array<keyof typeof oidcAndAuthVariables>;

const nodeRequiredEnv = {
	BETTER_AUTH_SECRET: "auth-secret",
	SYNC_TOKEN_SECRET: "sync-secret",
};

const cloudflareRequiredEnv = {
	SELF_HOSTED: true,
};

const request = new Request("https://example.com");

// AUTH_ALLOWED_EMAILS is deliberately absent from the shared fixture below.
// Both runtimes only require it when password sign-up is reachable, and the
// fixture disables password sign-up (AUTH_EMAIL_PASSWORD: "disabled") so the
// baseline parses cleanly without it. That makes removing AUTH_EMAIL_PASSWORD
// itself observable: it falls back to "enabled", which reinstates the
// allowlist requirement and both parsers should then reject the env.
function fullNodeEnv(): Record<string, unknown> {
	return { ...nodeRequiredEnv, ...oidcAndAuthVariables };
}

function fullCloudflareEnv(): Record<string, unknown> {
	return { ...cloudflareRequiredEnv, ...oidcAndAuthVariables };
}

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
	const clone = { ...source };
	delete clone[key];
	return clone;
}

function captureError(run: () => unknown): unknown {
	try {
		run();
		return undefined;
	} catch (error) {
		return error;
	}
}

// A normalized description of how a parser responded to a given env, used to
// compare the two runtimes without caring about incidental differences in
// error class or message wording (Node fails via zod's ZodError at parse
// time, Cloudflare fails via a plain Error thrown mid-request -- that
// difference is a deliberate, documented consequence of the two runtimes'
// boot models, not a parity bug).
type OidcReaction =
	| { outcome: "resolved"; oidc: OidcProviderConfig | undefined }
	| { outcome: "missing-oidc-vars"; missing: string[] }
	| { outcome: "rejected" };

function toReaction(run: () => OidcProviderConfig | undefined): OidcReaction {
	try {
		return { outcome: "resolved", oidc: run() };
	} catch (error) {
		if (error instanceof MissingOidcVariablesError) {
			return { outcome: "missing-oidc-vars", missing: [...error.missing].sort() };
		}
		return { outcome: "rejected" };
	}
}

function observeNodeReaction(env: Record<string, unknown>): OidcReaction {
	return toReaction(
		() => parseNodeServerConfig(env as Record<string, string | undefined>).oidc,
	);
}

function observeCloudflareReaction(env: Record<string, unknown>): OidcReaction {
	return toReaction(
		() => parseCloudflareHttpConfig(env as unknown as CloudflareRuntimeEnv, request).oidc,
	);
}

describe("OIDC config parity between the Cloudflare and Node runtimes", () => {
	it("produces equal OidcProviderConfig objects from both runtime parsers given the same env", () => {
		const nodeConfig = parseNodeServerConfig(
			fullNodeEnv() as Record<string, string | undefined>,
		);
		const cloudflareConfig = parseCloudflareHttpConfig(
			fullCloudflareEnv() as unknown as CloudflareRuntimeEnv,
			request,
		);

		expect(nodeConfig.oidc).toEqual(cloudflareConfig.oidc);
	});

	it("rejects the same partial OIDC configuration from both runtimes with identical missing-variable lists", () => {
		const partialOidc = { OIDC_CLIENT_ID: oidcAndAuthVariables.OIDC_CLIENT_ID };

		const nodeError = captureError(() =>
			parseNodeServerConfig({
				...nodeRequiredEnv,
				AUTH_ALLOWED_EMAILS: "owner@example.com",
				...partialOidc,
			}),
		);
		const cloudflareError = captureError(() =>
			parseCloudflareHttpConfig(
				{
					...cloudflareRequiredEnv,
					AUTH_ALLOWED_EMAILS: "owner@example.com",
					...partialOidc,
				} as unknown as CloudflareRuntimeEnv,
				request,
			),
		);

		expect(nodeError).toBeInstanceOf(MissingOidcVariablesError);
		expect(cloudflareError).toBeInstanceOf(MissingOidcVariablesError);
		expect((nodeError as MissingOidcVariablesError).missing).toEqual(
			(cloudflareError as MissingOidcVariablesError).missing,
		);
	});

	// This is the actual drift detector. A single shared-env equality check
	// (above) only proves the two parsers agree on the fixture as written --
	// it stays green if a future parser starts recognizing a differently
	// spelled or additional variable that this exact fixture never exercises.
	// Neither runtime exposes a runtime-reflectable list of the variable
	// names it reads (Node's is a zod schema, but Cloudflare's is a
	// TypeScript type erased at compile time, so there is no shared
	// reflection surface to compare). Instead, each canonical variable is
	// removed from an otherwise-complete env one at a time and both parsers'
	// reactions are compared: if a parser reads a variable, removing it
	// changes what that parser returns or throws. A parser that reads a
	// *different* variable name for the same setting (the historical
	// OIDC_DISPLAY_NAME vs. OIDC_PROVIDER_NAME bug) would show no reaction to
	// removing the canonical name at all, diverging from the other runtime.
	describe("fails when a parser's OIDC field set diverges from the other's", () => {
		it.each(CANONICAL_VARIABLE_NAMES)(
			"both runtimes react identically when %s is removed",
			(variable) => {
				const nodeReaction = observeNodeReaction(omit(fullNodeEnv(), variable));
				const cloudflareReaction = observeCloudflareReaction(
					omit(fullCloudflareEnv(), variable),
				);

				expect(nodeReaction).toEqual(cloudflareReaction);
			},
		);
	});
});
