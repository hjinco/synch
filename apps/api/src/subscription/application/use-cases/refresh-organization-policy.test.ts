import { describe, expect, it, vi } from "vitest";

import { getSubscriptionPlanPolicy } from "../../domain/policy";
import { RefreshOrganizationPolicyUseCase } from "./refresh-organization-policy";

describe("RefreshOrganizationPolicyUseCase", () => {
	it("applies the current limits to every active vault", async () => {
		const policyReader = {
			readOrganizationPolicy: vi.fn(async () => getSubscriptionPlanPolicy("starter")),
		};
		const vaultReader = {
			listActiveVaultIdsForOrganization: vi.fn(async () => ["vault-1", "vault-2"]),
		};
		const vaultPolicyWriter = {
			applyVaultPolicy: vi.fn(async () => {}),
		};

		await new RefreshOrganizationPolicyUseCase(
			policyReader,
			vaultReader,
			vaultPolicyWriter,
		).refreshOrganizationPolicy("org-1");

		expect(policyReader.readOrganizationPolicy).toHaveBeenCalledWith("org-1");
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
		const useCase = new RefreshOrganizationPolicyUseCase(
			{ readOrganizationPolicy: async () => getSubscriptionPlanPolicy("free") },
			{ listActiveVaultIdsForOrganization: async () => ["vault-1"] },
			vaultPolicyWriter,
		);

		await expect(useCase.refreshOrganizationPolicy("org-1")).rejects.toThrow();
	});
});
