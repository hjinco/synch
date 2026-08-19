import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";

import type { AppDb } from "../../../db/client";
import * as schema from "../../../db/d1";
import type { AuthFeatureConfig } from "../../application/dto/auth-config";
import type { AuthPersistence } from "../../application/ports/outbound/auth-persistence";
import {
	isEmailAllowed,
	parseAllowedEmails,
	SIGN_UP_EMAIL_NOT_ALLOWED,
} from "../../domain/allowed-emails";
import { defaultOrganizationSlug } from "../../domain/organization";
import { createEmailVerificationConfig } from "./better-auth-email";

export type BetterAuthConfig = AuthFeatureConfig & {
	plugins?: BetterAuthPlugin[];
};

/** Auth lifetime for signed-in clients (bearer token and cookies). */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export function createBetterAuth(
	db: AppDb,
	config: BetterAuthConfig,
	persistence: AuthPersistence,
) {
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
						if (await persistence.readDefaultOrganizationIdForUser(user.id)) {
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
						const organizationId =
							await persistence.readDefaultOrganizationIdForUser(session.userId);
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

						const organizationId =
							await persistence.readDefaultOrganizationIdForUser(session.userId);
						if (!organizationId) {
							return;
						}

						await persistence.setSessionActiveOrganization(
							session.id,
							organizationId,
						);
					},
				},
			},
		},
		plugins: [
			organization({ organizationLimit: 1 }),
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

export type BetterAuth = ReturnType<typeof createBetterAuth>;

function getDeviceVerificationUri(baseURL: string): string {
	return new URL("/device", baseURL).toString();
}
