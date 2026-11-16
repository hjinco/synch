import type { AppDb } from "../../db/client";
import type { EmailSender } from "../../platform/email";
import type { SubscriptionPolicyReader } from "../../subscription/application";
import { DrizzleSharingStore } from "../../sharing/adapters/drizzle-sharing-store";
import { EmailInvitationSender } from "../../sharing/adapters/email-invitation-sender";
import {
	createSharingService,
	SharingAccess,
	type SharingConfig,
	type SharingInvalidator,
} from "../../sharing/application";

export function createSharingFeature(deps: {
	db: AppDb;
	policyReader: SubscriptionPolicyReader;
	invalidator: SharingInvalidator;
}, config: Omit<SharingConfig, "invitationEmail"> & {
	email?: EmailSender;
	emailFrom?: string;
}) {
	const store = new DrizzleSharingStore(deps.db);
	return {
		access: new SharingAccess(store, deps.policyReader),
		service: createSharingService(store, deps.policyReader, deps.invalidator, {
			baseURL: config.baseURL,
			billingBaseURL: config.billingBaseURL,
			requireVerifiedEmail: config.requireVerifiedEmail,
			allowedEmails: config.allowedEmails,
			invitationEmail: config.email && config.emailFrom
				? new EmailInvitationSender(config.email, config.emailFrom)
				: undefined,
		}),
	};
}
