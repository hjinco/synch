import { asc, eq } from "drizzle-orm";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";
import {
	isEmailAllowed,
	parseAllowedEmails,
	SIGN_UP_EMAIL_NOT_ALLOWED,
} from "./policies/allowed-emails";
import { defaultOrganizationSlug } from "./policies/organization";

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
};

export type AuthPlugin = BetterAuthPlugin;
export type BetterAuthConfig = AuthFeatureConfig & {
	plugins?: AuthPlugin[];
};

/** Auth lifetime for signed-in clients (bearer token and cookies). */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export function createBetterAuth(db: AppDb, config: BetterAuthConfig) {
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
