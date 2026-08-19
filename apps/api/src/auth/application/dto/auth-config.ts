import type { EmailSender } from "../ports/outbound/email-sender";

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
