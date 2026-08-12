import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { extractCookieHeader, uniqueId } from "../../helpers/api";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

type SentEmail = {
	from: string | EmailAddress;
	to: string | string[];
	subject: string;
	text?: string;
	html?: string;
};

describe("auth email verification integration", () => {
	it("requires managed users to verify email before sign-in", async () => {
		const emailBinding = createCapturingEmailBinding();
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: false,
			EMAIL: emailBinding,
			AUTH_EMAIL_FROM: "Synch <noreply@example.com>",
			WWW_BASE_URL: "https://synch.run",
		};
		const callbackURL = "https://synch.run/dashboard";
		const account = {
			email: `${uniqueId("managed-auth")}@example.com`,
			password: "supersecret123",
		};

		const signUp = await jsonRequestWithEnv<{ token: string | null }>(
			"/api/auth/sign-up/email",
			testEnv,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					name: "Managed User",
					email: account.email,
					password: account.password,
					callbackURL,
				}),
			},
		);

		expect(signUp.response.status).toBe(200);
		expect(signUp.json?.token).toBeNull();
		expect(extractCookieHeader(signUp.response)).not.toContain("better-auth.session_token=");
		expect(emailBinding.sent).toHaveLength(1);
		expect(emailBinding.sent[0]).toMatchObject({
			from: "Synch <noreply@example.com>",
			to: account.email,
		});
		expect(emailBinding.sent[0]?.subject).toBeTruthy();
		expect(emailBinding.sent[0]?.text).toContain("/verify-email?token=");
		expect(emailBinding.sent[0]?.text).toContain(
			"callbackURL=https%3A%2F%2Fsynch.run%2Fdashboard",
		);
		expect(emailBinding.sent[0]?.html).toContain("/verify-email?token=");

		const verificationUrl = extractVerificationUrl(emailBinding.sent[0]?.text ?? "");
		const verified = await requestWithEnv(
			`${verificationUrl.pathname}${verificationUrl.search}`,
			testEnv,
			{ redirect: "manual" },
		);
		expect(verified.status).toBe(302);
		expect(verified.headers.get("location")).toBe(callbackURL);

		const signIn = await jsonRequestWithEnv<{ token: string | null }>(
			"/api/auth/sign-in/email",
			testEnv,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(account),
			},
		);

		expect(signIn.response.status).toBe(200);
		expect(signIn.json?.token).toBeTruthy();
		expect(extractCookieHeader(signIn.response)).toContain("better-auth.session_token=");
	});

	it("keeps self-hosted sign-up independent from email configuration", async () => {
		const accountEmail = `${uniqueId("self-hosted-auth")}@example.com`;
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: true,
			EMAIL: undefined,
			AUTH_ALLOWED_EMAILS: accountEmail,
		};

		const signUp = await jsonRequestWithEnv<{ token: string | null }>(
			"/api/auth/sign-up/email",
			testEnv,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					name: "Self Hosted User",
					email: accountEmail,
					password: "supersecret123",
				}),
			},
		);

		expect(signUp.response.status).toBe(200);
		expect(signUp.json?.token).toBeTruthy();
		expect(extractCookieHeader(signUp.response)).toContain("better-auth.session_token=");
	});

	it.each([undefined, "   "])(
		"fails closed when the self-hosted email allowlist is %s",
		async (authAllowedEmails) => {
			const testEnv: RuntimeTestEnv = {
				...env,
				SELF_HOSTED: true,
				AUTH_ALLOWED_EMAILS: authAllowedEmails,
			};

			await expect(requestWithEnv("/health", testEnv)).rejects.toThrow();
		},
	);

	it("restricts self-hosted sign-up to the configured email allowlist", async () => {
		const allowedEmail = `${uniqueId("allowed-self-hosted-auth")}@example.com`;
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: true,
			EMAIL: undefined,
			AUTH_ALLOWED_EMAILS: ` OTHER@example.com, ${allowedEmail.toUpperCase()} `,
		};
		const signUp = (email: string) =>
			jsonRequestWithEnv<{ token?: string; code?: string; message?: string }>(
				"/api/auth/sign-up/email",
				testEnv,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: "Self Hosted User",
						email,
						password: "supersecret123",
					}),
				},
			);

		const denied = await signUp(`${uniqueId("denied-self-hosted-auth")}@example.com`);
		expect(denied.response.status).toBe(403);
		expect(denied.json).toMatchObject({
			code: "SIGN_UP_EMAIL_NOT_ALLOWED",
		});
		expect(extractCookieHeader(denied.response)).not.toContain("better-auth.session_token=");

		const allowed = await signUp(allowedEmail);
		expect(allowed.response.status).toBe(200);
		expect(allowed.json?.token).toBeTruthy();
		expect(extractCookieHeader(allowed.response)).toContain("better-auth.session_token=");
	});
});

async function jsonRequestWithEnv<T = unknown>(
	path: string,
	testEnv: RuntimeTestEnv,
	init: RequestInit = {},
): Promise<{ response: Response; json: T | null; text: string }> {
	const response = await requestWithEnv(path, testEnv, init);
	const text = await response.text();

	return {
		response,
		text,
		json: text ? (JSON.parse(text) as T) : null,
	};
}

function createCapturingEmailBinding(): SendEmail & { sent: SentEmail[] } {
	const sent: SentEmail[] = [];

	return {
		sent,
		async send(message: EmailMessage | SentEmail) {
			if ("subject" in message) {
				sent.push(message);
			}

			return { messageId: crypto.randomUUID() };
		},
	} as SendEmail & { sent: SentEmail[] };
}

function extractVerificationUrl(text: string): URL {
	const match = text.match(/https?:\/\/\S+/);
	if (!match) {
		throw new Error("verification email did not contain an absolute URL");
	}

	return new URL(match[0]);
}
