import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";
import { getDeviceVerificationUri } from "./device";
import { createEmailVerificationConfig } from "./email";
import {
	defaultOrganizationSlug,
	readDefaultOrganizationIdForUserId,
} from "./organization";

export type AuthConfig = {
	baseURL: string;
	trustedOrigins: string[];
	selfHosted: boolean;
	devMode: boolean;
	email?: SendEmail;
	emailFrom?: string;
	plugins?: BetterAuthPlugin[];
};

/** Auth session lifetime for signed-in clients (plugin bearer token, cookies). */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export function createAuth(db: AppDb, config: AuthConfig) {
	const emailVerification = createEmailVerificationConfig(config);
	const auth = betterAuth({
		baseURL: config.baseURL,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema,
		}),
		trustedOrigins: config.trustedOrigins,
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: !config.selfHosted && !config.devMode,
		},
		emailVerification,
		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
		},
		databaseHooks: {
			user: {
				create: {
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
