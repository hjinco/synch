import { describe, expect, it } from "vitest";

import { getSubscriptionPlanPolicy } from "../../domain/policy";
import type { SubscriptionPolicyDataReader } from "../ports/outbound/subscription-policy-data-reader";
import { ReadOrganizationPolicyUseCase } from "./read-organization-policy";

describe("ReadOrganizationPolicyUseCase", () => {
	it("uses the hosted free policy when no persistence reader is configured", async () => {
		await expect(
			new ReadOrganizationPolicyUseCase().readOrganizationPolicy("org-1"),
		).resolves.toEqual(getSubscriptionPlanPolicy("free"));
	});

	it("uses the self-hosted policy for self-hosted deployments", async () => {
		await expect(
			new ReadOrganizationPolicyUseCase({ selfHosted: true }).readOrganizationPolicy(
				"org-1",
			),
		).resolves.toEqual(getSubscriptionPlanPolicy("self_hosted"));
	});

	it("uses the starter policy for a matching active product subscription", async () => {
		const useCase = new ReadOrganizationPolicyUseCase({
			dataReader: policyDataReader({
				subscriptions: [
					{
						productId: "starter-annual-product",
						status: "active",
						periodEnd: new Date(Date.now() + 60_000),
					},
				],
			}),
			productIdsByPlanId: {
				starter: {
					monthly: "starter-monthly-product",
					annual: "starter-annual-product",
				},
			},
		});

		await expect(useCase.readOrganizationPolicy("org-1")).resolves.toMatchObject({
			id: "starter",
		});
	});

	it("ignores active subscriptions for unknown products", async () => {
		const useCase = new ReadOrganizationPolicyUseCase({
			dataReader: policyDataReader({
				subscriptions: [
					{
						productId: "other-product",
						status: "active",
						periodEnd: new Date(Date.now() + 60_000),
					},
				],
			}),
			productIdsByPlanId: {
				starter: {
					monthly: "starter-monthly-product",
					annual: "starter-annual-product",
				},
			},
		});

		await expect(useCase.readOrganizationPolicy("org-1")).resolves.toMatchObject({
			id: "free",
		});
	});

	it("applies organization synced vault overrides on top of the plan policy", async () => {
		const useCase = new ReadOrganizationPolicyUseCase({
			dataReader: policyDataReader({
				organization: { syncedVaults: 3 },
			}),
		});

		const basePolicy = getSubscriptionPlanPolicy("free");
		await expect(useCase.readOrganizationPolicy("org-1")).resolves.toEqual({
			...basePolicy,
			limits: { ...basePolicy.limits, syncedVaults: 3 },
		});
	});
});

function policyDataReader(
	data: Partial<Awaited<ReturnType<SubscriptionPolicyDataReader["readOrganizationPolicyData"]>>>,
): SubscriptionPolicyDataReader {
	return {
		readOrganizationPolicyData: async () => ({
			subscriptions: [],
			organization: null,
			...data,
		}),
	};
}
