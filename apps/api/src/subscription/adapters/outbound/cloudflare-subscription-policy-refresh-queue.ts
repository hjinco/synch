import type { SubscriptionPolicyRefreshMessage } from "../../application/dto/subscription-policy-refresh-message";
import type { SubscriptionPolicyRefreshQueue } from "../../application/ports/outbound/subscription-policy-refresh-queue";

export class CloudflareSubscriptionPolicyRefreshQueue
	implements SubscriptionPolicyRefreshQueue
{
	constructor(private readonly queue: Queue<SubscriptionPolicyRefreshMessage>) {}

	async enqueueOrganizationPolicyRefresh(organizationId: string): Promise<void> {
		await this.queue.send({
			type: "subscription_policy_refresh",
			organizationId,
		});
	}
}
