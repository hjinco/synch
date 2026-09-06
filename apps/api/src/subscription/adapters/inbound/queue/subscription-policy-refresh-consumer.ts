import type { RefreshOrganizationPolicy } from "../../../application/ports/inbound/refresh-organization-policy";
import type { SubscriptionPolicyRefreshMessage } from "../../../application/dto/subscription-policy-refresh-message";

export class SubscriptionPolicyRefreshConsumer {
	constructor(
		private readonly refreshOrganizationPolicyService: RefreshOrganizationPolicy,
	) {}

	async refreshOrganizationPolicy(organizationId: string): Promise<void> {
		await this.refreshOrganizationPolicyService.refreshOrganizationPolicy(
			organizationId,
		);
	}

	async handleMessage(message: Message<SubscriptionPolicyRefreshMessage>): Promise<void> {
		const body = message.body;
		if (
			body?.type !== "subscription_policy_refresh" ||
			!body.organizationId.trim()
		) {
			message.ack();
			return;
		}

		try {
			await this.refreshOrganizationPolicy(body.organizationId);
			message.ack();
		} catch {
			message.retry();
		}
	}
}
