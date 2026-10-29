import { asc, eq } from "drizzle-orm";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import {
	bearer,
	deviceAuthorization,
	genericOAuth,
	lastLoginMethod,
	organization,
} from "better-auth/plugins";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";
import {
	isAllowlistExemptSource,
	isEmailAllowed,
	parseAllowedEmails,
	SIGN_UP_EMAIL_NOT_ALLOWED,
} from "./policies/allowed-emails";
import { defaultOrganizationSlug } from "./policies/organization";
import type { OidcProviderConfig } from "./policies/oidc";
import { recordOidcDiagnostic, shouldEmitOidcDiagnostic } from "./oidc-diagnostics";

export type OutgoingEmail = {
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
};

export type EmailSender = {
	send(message: OutgoingEmail): Promise<unknown>;
};

export type AuthFeatureConfig = {
	baseURL: string;
	trustedOrigins: string[];
	emailVerification: "required" | "disabled";
	devMode: boolean;
	secret?: string;
	email?: EmailSender;
	emailFrom?: string;
	allowedEmails?: string;
	googleClientId?: string;
	googleClientSecret?: string;
	githubClientId?: string;
	githubClientSecret?: string;
	/** Registers the `generic-oauth` plugin against this provider when present. */
	oidc?: OidcProviderConfig;
	/**
	 * Toggles the `emailAndPassword` provider. Left unset, email/password stays
	 * enabled -- the historical default.
	 */
	emailAndPassword?: "enabled" | "disabled";
};

export type AuthPlugin = BetterAuthPlugin;
export type BetterAuthConfig = AuthFeatureConfig & {
	plugins?: AuthPlugin[];
};

/**
 * Mutable status sink written to by the OIDC plugin's isolated `init` (see
 * `withOidcInitIsolation`) and read back by the caller after construction.
 * `available` starts `true` -- optimistic until proven otherwise, the same
 * stance the rebuild-on-use logic in `createAuthFeature` takes with the
 * whole auth context -- and flips to `false` the moment discovery or any
 * other construction-time check for this provider fails.
 */
export type OidcAvailability = {
	available: boolean;
};

/** Auth lifetime for signed-in clients (bearer token and cookies). */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export function createBetterAuth(
	db: AppDb,
	config: BetterAuthConfig,
	oidcAvailability?: OidcAvailability,
) {
	const emailVerification = createEmailVerificationConfig(config);
	const allowedEmails = parseAllowedEmails(config.allowedEmails);
	const auth = betterAuth({
		socialProviders: {
			google: optionalOAuthProvider(config.baseURL, "google", config.googleClientId, config.googleClientSecret),
			github: optionalOAuthProvider(config.baseURL, "github", config.githubClientId, config.githubClientSecret),
		},
		baseURL: config.baseURL,
		secret: config.secret,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema,
		}),
		trustedOrigins: config.trustedOrigins,
		emailAndPassword: {
			enabled: config.emailAndPassword !== "disabled",
			requireEmailVerification:
				config.emailVerification === "required" && !config.devMode,
		},
		emailVerification,
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: config.oidc ? [config.oidc.providerId] : [],
				// Community deployments never verify email locally (emailVerification
				// is "disabled" there), so the local-row gate would otherwise block
				// every account link. Upstream marks this option deprecated with a
				// FIXME to make the gate unconditional on the next minor, so a future
				// better-auth upgrade will need to revisit this setting and confirm
				// account-linking behavior is still correct without it.
				requireLocalEmailVerified: config.oidc ? false : config.emailVerification === "required",
			},
		},
		user: {
			validateUserInfo: async ({ user, source }) => {
				// validateUserInfo is used here -- rather than the previous
				// databaseHooks.user.create.before throw -- because it is the only
				// hook that receives source.method and source.oauth.providerId,
				// which isAllowlistExemptSource needs to recognize a sign-up the
				// configured OIDC provider vouches for. The identity provider is the
				// authority for identities it asserts, so a sign-up federated
				// through the configured OIDC provider bypasses the email allowlist;
				// every other creation path (password, and any future auth method
				// Better Auth adds) stays gated.
				// Check the current provider assertion on both signup and returning login.
				if (source.method === "oauth" && user.emailVerified !== true && !isAllowlistExemptSource(source)) {
					return {
						error: "email_not_verified",
						errorDescription: "Verify your email with your sign-in provider before signing in.",
					};
				}
				if (isAllowlistExemptSource(source)) {
					return;
				}
				if (
					allowedEmails &&
					(typeof user.email !== "string" || !isEmailAllowed(user.email, allowedEmails))
				) {
					// The rejected email is attacker-supplied input (this hook runs
					// before any credential is verified), so it must never reach the
					// log -- only the stable rejection code and the method that was
					// attempted, which is exactly enough for an operator to see that
					// the allowlist is doing its job without exposing who tried it.
					const key = `allowlist-rejection:${SIGN_UP_EMAIL_NOT_ALLOWED.code}:${source.method}`;
					if (shouldEmitOidcDiagnostic(key)) {
						recordOidcDiagnostic(key, {
							code: SIGN_UP_EMAIL_NOT_ALLOWED.code,
							method: source.method,
						});
					}
					return {
						error: SIGN_UP_EMAIL_NOT_ALLOWED.code,
						errorDescription: SIGN_UP_EMAIL_NOT_ALLOWED.message,
					};
				}
			},
		},
		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/sign-up/email") return;
				const body: unknown = ctx.body;
				if (!body || typeof body !== "object" || !("email" in body) || typeof body.email !== "string") return;
				const existing = await ctx.context.internalAdapter.findUserByEmail(body.email.toLowerCase());
				if (existing) {
					// Return an explicit error even when email verification is required;
					// Better Auth otherwise responds as if it sent a verification email.
					throw APIError.from("UNPROCESSABLE_ENTITY", {
						code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
						message: "This email is already registered. Please sign in instead.",
					});
				}
			}),
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						if (await readDefaultOrganizationIdForUser(db, user.id)) {
							return;
						}

						await auth.api.createOrganization({
							body: {
								name: "Personal Organization",
								slug: defaultOrganizationSlug(user.id),
								userId: user.id,
								keepCurrentActiveOrganization: true,
							},
						});
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						const organizationId = await readDefaultOrganizationIdForUser(
							db,
							session.userId,
						);
						if (!organizationId) {
							return;
						}

						return {
							data: {
								...session,
								activeOrganizationId: organizationId,
							},
						};
					},
					after: async (session) => {
						if (
							typeof session.activeOrganizationId === "string" &&
							session.activeOrganizationId
						) {
							return;
						}

						const organizationId = await readDefaultOrganizationIdForUser(
							db,
							session.userId,
						);
						if (!organizationId) {
							return;
						}

						await setSessionActiveOrganization(db, session.id, organizationId);
					},
				},
			},
		},
		plugins: [
			organization({ organizationLimit: 1 }),
			lastLoginMethod({
				// Managed email sign-up creates a session only after verification.
				customResolveMethod: (ctx) => ctx.path === "/verify-email" ? "email" : null,
			}),
			...(config.oidc
				? [
						withOidcInitIsolation(
							genericOAuth({
								config: [
									{
										providerId: config.oidc.providerId,
										clientId: config.oidc.clientId,
										clientSecret: config.oidc.clientSecret,
										discoveryUrl: config.oidc.discoveryUrl,
										scopes: config.oidc.scopes,
										pkce: true,
										requireIdTokenVerification: true,
										accountIssuer: config.oidc.accountIssuer,
									},
								],
							}),
							config.oidc,
							oidcAvailability,
						),
					]
				: []),
			...(config.plugins ?? []),
			bearer(),
			deviceAuthorization({
				verificationUri: getDeviceVerificationUri(config.baseURL),
				schema: {},
			}),
		],
	});

	return auth;
}

/**
 * better-auth's plugin loop (`runPluginInit`) has no try/catch around a
 * plugin's `init` -- a throw there rejects the *entire* shared auth context,
 * which is why an unreachable OIDC provider previously took password
 * sign-in and every existing session down with it, not just OIDC sign-in.
 * Wrapping `init` here contains a discovery/configuration failure to just
 * this provider: the plugin's own throw becomes a caught, diagnosed failure
 * and `init` resolves to `void` -- a documented no-op return per
 * `BetterAuthPlugin["init"]`'s type -- so the rest of the context (and every
 * unrelated plugin) still builds normally and this provider is simply left
 * unregistered. `sign-in/social` against an unregistered provider fails
 * closed with a 404, never with a live, unverified token.
 */
function withOidcInitIsolation(
	plugin: AuthPlugin,
	oidc: OidcProviderConfig,
	oidcAvailability: OidcAvailability | undefined,
): AuthPlugin {
	const originalInit = plugin.init;
	if (!originalInit) {
		return plugin;
	}

	// better-auth's own `init` type is a union of function shapes
	// (`Awaitable<{...}> | void | Promise<void>`) that a single function
	// implementation returning either branch cannot satisfy structurally --
	// this wrapper only ever forwards `originalInit`'s own (already
	// correctly typed) result unchanged or produces the documented no-op
	// `void` return, so the cast is asserting a shape TypeScript cannot
	// otherwise verify across that union, not bypassing real type safety.
	async function isolatedInit(
		...args: Parameters<NonNullable<AuthPlugin["init"]>>
	): Promise<Awaited<ReturnType<NonNullable<AuthPlugin["init"]>>> | void> {
		try {
			// Narrowed by the early return above; TypeScript doesn't carry that
			// narrowing of a closed-over `const` into this nested function.
			return await originalInit!(...args);
		} catch (error) {
			if (oidcAvailability) {
				oidcAvailability.available = false;
			}
			const errorClass = classifyOidcInitError(error);
			const key = `${oidc.providerId}:${oidc.discoveryUrl}:${errorClass}`;
			if (shouldEmitOidcDiagnostic(key)) {
				recordOidcDiagnostic(key, {
					providerId: oidc.providerId,
					discoveryUrl: oidc.discoveryUrl,
					errorClass,
				});
			}
			return;
		}
	}

	return {
		...plugin,
		init: isolatedInit as AuthPlugin["init"],
	};
}

/**
 * Classifies an OIDC init failure into a small, bounded set of categories
 * instead of logging the raw error: the message text is safe here (better-
 * auth's own construction-time throws only ever mention the provider id),
 * but a fixed category is still preferable so this never becomes a channel
 * for stack traces or cause chains to leak through, and so the dedup key
 * built from it distinguishes genuinely different misconfigurations (a
 * discovery outage should not hide a subsequent invalid-jwks-uri problem).
 */
function classifyOidcInitError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "unknown";
	}

	if (error.message.includes("discovery did not return an issuer")) {
		return "discovery-missing-issuer";
	}
	if (error.message.includes("invalid jwks_uri")) {
		return "discovery-invalid-jwks-uri";
	}
	if (error.message.includes("discovery returned no valid data")) {
		return "discovery-unavailable";
	}
	if (error.message.includes("requires verified ID tokens")) {
		return "id-token-verification-unavailable";
	}

	return error.name || "error";
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;

async function readDefaultOrganizationIdForUser(
	db: AppDb,
	userId: string,
): Promise<string | null> {
	const rows = await db
		.select({
			organizationId: schema.member.organizationId,
		})
		.from(schema.member)
		.where(eq(schema.member.userId, userId))
		.orderBy(asc(schema.member.createdAt))
		.limit(1);

	return rows[0]?.organizationId ?? null;
}

async function setSessionActiveOrganization(
	db: AppDb,
	sessionId: string,
	organizationId: string,
): Promise<void> {
	await db
		.update(schema.session)
		.set({ activeOrganizationId: organizationId })
		.where(eq(schema.session.id, sessionId));
}

function createEmailVerificationConfig(config: AuthFeatureConfig) {
	if (config.emailVerification === "disabled" || config.devMode) {
		return undefined;
	}

	if (!config.email) {
		throw new Error("Email delivery is required when email verification is enabled.");
	}
	if (!config.emailFrom) {
		throw new Error("AUTH_EMAIL_FROM is required when email verification is enabled.");
	}

	const email = config.email;
	const emailFrom = config.emailFrom;

	return {
		sendOnSignUp: true,
		sendOnSignIn: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
			const subject = "Verify your Synch email";
			const text = [
				"Verify your Synch email address by opening this link:",
				"",
				url,
				"",
				"If you did not create a Synch account, you can ignore this email.",
			].join("\n");
			const html = [
				"<p>Verify your Synch email address by opening this link:</p>",
				`<p><a href="${escapeHtml(url)}">Verify email</a></p>`,
				`<p>${escapeHtml(url)}</p>`,
				"<p>If you did not create a Synch account, you can ignore this email.</p>",
			].join("");

			await email.send({
				from: emailFrom,
				to: user.email,
				subject,
				text,
				html,
			});
		},
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return char;
		}
	});
}

function getDeviceVerificationUri(baseURL: string): string {
	return new URL("/device", baseURL).toString();
}

function optionalOAuthProvider(baseURL: string, provider: "google" | "github", id?: string, secret?: string) {
	const clientId = id?.trim();
	const clientSecret = secret?.trim();
	return clientId && clientSecret ? {
		clientId,
		clientSecret,
		// Used for both the authorization request and the token exchange.
		redirectURI: new URL(`/v1/auth/callback/${provider}`, baseURL).toString(),
	} : undefined;
}
