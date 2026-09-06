import { describe, expect, it, vi } from "vitest";

import { SubscriptionPolicyRefreshConsumer } from "./subscription-policy-refresh-consumer";

describe("SubscriptionPolicyRefreshConsumer", () => {
	it("refreshes organization policy and acknowledges the queue message", async () => {
		const refreshOrganizationPolicyService = {
			refreshOrganizationPolicy: vi.fn(async () => {}),
		};
		const message = {
			body: {
				type: "subscription_policy_refresh",
				organizationId: "org-1",
			},
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new SubscriptionPolicyRefreshConsumer(
			refreshOrganizationPolicyService,
		);

		await consumer.handleMessage(message as never);

		expect(
			refreshOrganizationPolicyService.refreshOrganizationPolicy,
		).toHaveBeenCalledWith("org-1");
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it("retries the queue message when policy refresh fails", async () => {
		const refreshOrganizationPolicyService = {
			refreshOrganizationPolicy: vi.fn(async () => {
				throw new Error("coordinator unavailable");
			}),
		};
		const message = {
			body: {
				type: "subscription_policy_refresh",
				organizationId: "org-1",
			},
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new SubscriptionPolicyRefreshConsumer(
			refreshOrganizationPolicyService,
		);

		await consumer.handleMessage(message as never);

		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});
});
