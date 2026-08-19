import { describe, expect, it } from "vitest";

import { getSubscriptionPlanPolicy } from "../../domain/policy";
import { CoordinatorVaultPolicyWriter } from "./coordinator-vault-policy-writer";

describe("CoordinatorVaultPolicyWriter", () => {
	it("turns non-2xx coordinator responses into adapter failures", async () => {
		const writer = new CoordinatorVaultPolicyWriter({
			applyVaultPolicy: async () => new Response(null, { status: 503 }),
		});

		await expect(
			writer.applyVaultPolicy("vault-1", getSubscriptionPlanPolicy("free").limits),
		).rejects.toThrow();
	});

	it("completes successfully for an accepted coordinator response", async () => {
		const writer = new CoordinatorVaultPolicyWriter({
			applyVaultPolicy: async () => new Response(null, { status: 204 }),
		});

		await expect(
			writer.applyVaultPolicy("vault-1", getSubscriptionPlanPolicy("free").limits),
		).resolves.toBeUndefined();
	});
});
