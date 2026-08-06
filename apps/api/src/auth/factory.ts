import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";
import {
	isEmailAllowed,
	parseAllowedEmails,
	SIGN_UP_EMAIL_NOT_ALLOWED,
} from "./allowed-emails";
import { getDeviceVerificationUri } from "./device";
import { createEmailVerificationConfig } from "./email";
import type { EmailSender } from "./ports";
import {
	defaultOrganizationSlug,
	readDefaultOrganizationIdForUserId,
} from "./organization";

export type AuthConfig = {
	baseURL: string;
	trustedOrigins: string[];
	emailVerification: "required" | "disabled";
	devMode: boolean;
	/** Signing secret for sessions/cookies/CSRF. Falls back to better-auth's own `BETTER_AUTH_SECRET` env lookup when omitted (the Cloudflare path). */
	secret?: string;
	email?: EmailSender;
	emailFrom?: string;
	/** Comma-separated email addresses allowed to create accounts. Blank or omitted keeps sign-up open. */
	allowedEmails?: string;
	plugins?: BetterAuthPlugin[];
};

/** Auth session lifetime for signed-in clients (plugin bearer token, cookies). */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export function createAuth(db: AppDb, config: AuthConfig) {
	const emailVerification = createEmailVerificationConfig(config);
	const allowedEmails = parseAllowedEmails(config.allowedEmails);
	const auth = betterAuth({
		baseURL: config.baseURL,
		secret: config.secret,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema,
		}),
		trustedOrigins: config.trustedOrigins,
		emailAndPassword: {
			enabled: true,
			requireEmailVerification:
				config.emailVerification === "required" && !config.devMode,
		},
		emailVerification,
		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if (allowedEmails && !isEmailAllowed(user.email, allowedEmails)) {
							throw APIError.from("FORBIDDEN", SIGN_UP_EMAIL_NOT_ALLOWED);
						}
					},
					after: async (user) => {
						if (await readDefaultOrganizationIdForUserId(db, user.id)) {
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
						const organizationId = await readDefaultOrganizationIdForUserId(db, session.userId);
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
						if (typeof session.activeOrganizationId === "string" && session.activeOrganizationId) {
							return;
						}

						const organizationId = await readDefaultOrganizationIdForUserId(db, session.userId);
						if (!organizationId) {
							return;
						}

						await db
							.update(schema.session)
							.set({ activeOrganizationId: organizationId })
							.where(eq(schema.session.id, session.id));
					},
				},
			},
		},
		plugins: [
			organization({
				organizationLimit: 1,
			}),
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

export type Auth = ReturnType<typeof createAuth>;
