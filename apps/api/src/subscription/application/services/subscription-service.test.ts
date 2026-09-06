import { describe, expect, it, vi } from "vitest";

import { getSubscriptionPlanPolicy } from "../../domain/policy";
import type { SubscriptionPolicyDataReader } from "../ports/outbound/subscription-policy-data-reader";
import { SubscriptionService } from "./subscription-service";

describe("SubscriptionService", () => {
	describe("readOrganizationPolicy", () => {
		it("uses the hosted free policy when no persistence reader is configured", async () => {
			await expect(
				new SubscriptionService().readOrganizationPolicy("org-1"),
			).resolves.toEqual(getSubscriptionPlanPolicy("free"));
		});

		it("uses the self-hosted policy for self-hosted deployments", async () => {
			await expect(
				new SubscriptionService({ selfHosted: true }).readOrganizationPolicy(
					"org-1",
				),
			).resolves.toEqual(getSubscriptionPlanPolicy("self_hosted"));
		});

		it("uses the starter policy for a matching active product subscription", async () => {
			const service = new SubscriptionService({
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

			await expect(service.readOrganizationPolicy("org-1")).resolves.toMatchObject({
				id: "starter",
			});
		});

		it("ignores active subscriptions for unknown products", async () => {
			const service = new SubscriptionService({
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

			await expect(service.readOrganizationPolicy("org-1")).resolves.toMatchObject({
				id: "free",
			});
		});

		it("applies organization synced vault overrides on top of the plan policy", async () => {
			const service = new SubscriptionService({
				dataReader: policyDataReader({
					organization: { syncedVaults: 3 },
				}),
			});

			const basePolicy = getSubscriptionPlanPolicy("free");
			await expect(service.readOrganizationPolicy("org-1")).resolves.toEqual({
				...basePolicy,
				limits: { ...basePolicy.limits, syncedVaults: 3 },
			});
		});
	});

	describe("refreshOrganizationPolicy", () => {
		it("applies the current limits to every active vault", async () => {
			const vaultReader = {
				listActiveVaultIdsForOrganization: vi.fn(async () => ["vault-1", "vault-2"]),
			};
			const vaultPolicyWriter = {
				applyVaultPolicy: vi.fn(async () => {}),
			};
			const service = new SubscriptionService({
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
				vaultReader,
				vaultPolicyWriter,
			});

			await service.refreshOrganizationPolicy("org-1");

			expect(vaultReader.listActiveVaultIdsForOrganization).toHaveBeenCalledWith("org-1");
			expect(vaultPolicyWriter.applyVaultPolicy).toHaveBeenCalledTimes(2);
			expect(vaultPolicyWriter.applyVaultPolicy).toHaveBeenCalledWith(
				"vault-1",
				getSubscriptionPlanPolicy("starter").limits,
			);
		});

		it("rejects when a vault policy cannot be applied", async () => {
			const vaultPolicyWriter = {
				applyVaultPolicy: vi.fn(async () => {
					throw new Error("vault policy refresh failed");
				}),
			};
			const service = new SubscriptionService({
				vaultReader: { listActiveVaultIdsForOrganization: async () => ["vault-1"] },
				vaultPolicyWriter,
			});

			await expect(service.refreshOrganizationPolicy("org-1")).rejects.toThrow();
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
