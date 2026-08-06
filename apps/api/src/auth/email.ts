import type { AuthConfig } from "./factory";

export function createEmailVerificationConfig(config: AuthConfig) {
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
