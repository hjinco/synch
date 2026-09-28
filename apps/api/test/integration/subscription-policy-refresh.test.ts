import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createQueueConsumer } from "../../src/runtime";
import {
	getSubscriptionPlanPolicy,
	type SubscriptionPlanPolicy,
} from "../../src/subscription/domain/policy";
import { signUpAndCreateVault } from "../helpers/api";
import { createDb } from "../../src/db/client";
import { DrizzleBillingStore } from "../../src/billing/adapters/outbound/drizzle-billing-store";

describe("subscription policy refresh integration", () => {
	it("rolls back a subscription when its billing customer belongs to another organization", async () => {
		const first = await signUpAndCreateVault();
		const second = await signUpAndCreateVault();
		const store = new DrizzleBillingStore(createDb(env.DB));
		const input = {
			id: "isolated-sub-1", productId: "test-plus-monthly", organizationId: first.organizationId,
			polarCustomerId: "isolated-customer", polarSubscriptionId: "isolated-polar-sub-1",
			polarCheckoutId: null, status: "active", periodStart: new Date(),
			periodEnd: new Date(Date.now() + 86400000), cancelAtPeriodEnd: false,
		};
		await store.upsertPolarSubscription(input);

		await expect(store.upsertPolarSubscription({
			...input, id: "isolated-sub-2", polarSubscriptionId: "isolated-polar-sub-2", organizationId: second.organizationId,
		})).rejects.toThrow();

		expect(await store.readOrganizationSubscriptionStatuses(second.organizationId)).toEqual([]);
		expect(await store.readOrganizationPolarCustomerId(second.organizationId)).toBeNull();
		expect(await store.readOrganizationPolarCustomerId(first.organizationId)).toBe("isolated-customer");
	});

	it("applies changed subscription policy limits to active vault durable object state", async () => {
		const starterProductId = "polar-product-starter";
		const primary = await signUpAndCreateVault("Policy refresh vault");
		const freePolicy = getSubscriptionPlanPolicy("free");
		const starterPolicy = getSubscriptionPlanPolicy("starter");

		await initializeVaultPolicyState(primary.vaultId, freePolicy);
		await upsertSubscription({
			organizationId: primary.organizationId,
			productId: starterProductId,
			status: "active",
			periodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
		});

		const message = {
			body: {
				type: "subscription_policy_refresh",
				organizationId: primary.organizationId,
			},
			ack: vi.fn(),
			retry: vi.fn(),
		};

		await createQueueConsumer({
			...env,
			POLAR_STARTER_MONTHLY_PRODUCT_ID: starterProductId,
		}).handleBatch({
			messages: [message],
		} as never);

		await expect(readVaultPolicyState(primary.vaultId)).resolves.toEqual({
			storageLimitBytes: starterPolicy.limits.storageLimitBytes,
			maxFileSizeBytes: starterPolicy.limits.maxFileSizeBytes,
			versionHistoryRetentionDays:
				starterPolicy.limits.versionHistoryRetentionDays,
		});
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});
});

async function initializeVaultPolicyState(
	vaultId: string,
	policy: SubscriptionPlanPolicy,
): Promise<void> {
	const stub = env.SYNC_COORDINATOR.getByName(vaultId);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			`
			INSERT INTO coordinator_state (
				id,
				vault_id,
				storage_limit_bytes,
				max_file_size_bytes,
				version_history_retention_days
			)
			VALUES (1, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				vault_id = excluded.vault_id,
				storage_limit_bytes = excluded.storage_limit_bytes,
				max_file_size_bytes = excluded.max_file_size_bytes,
				version_history_retention_days = excluded.version_history_retention_days
			`,
			vaultId,
			policy.limits.storageLimitBytes,
			policy.limits.maxFileSizeBytes,
			policy.limits.versionHistoryRetentionDays,
		);
	});
}

async function readVaultPolicyState(
	vaultId: string,
): Promise<{
	storageLimitBytes: number;
	maxFileSizeBytes: number;
	versionHistoryRetentionDays: number;
}> {
	const stub = env.SYNC_COORDINATOR.getByName(vaultId);
	return await runInDurableObject(stub, async (_instance, state) => {
		const row = state.storage.sql
			.exec<{
				storage_limit_bytes: number;
				max_file_size_bytes: number;
				version_history_retention_days: number;
			}>(
				`
				SELECT
					storage_limit_bytes,
					max_file_size_bytes,
					version_history_retention_days
				FROM coordinator_state
				WHERE id = 1
				`,
			)
			.toArray()[0];

		if (!row) {
			throw new Error("coordinator_state row was not initialized");
		}

		return {
			storageLimitBytes: Number(row.storage_limit_bytes),
			maxFileSizeBytes: Number(row.max_file_size_bytes),
			versionHistoryRetentionDays: Number(row.version_history_retention_days),
		};
	});
}

async function upsertSubscription(input: {
	organizationId: string;
	productId: string;
	status: string;
	periodEnd: number;
}): Promise<void> {
	const subscriptionId = `sub-${crypto.randomUUID()}`;
	await env.DB.prepare(
		[
			"INSERT INTO polar_subscription (",
			"id, product_id, organization_id, polar_customer_id,",
			"polar_subscription_id, polar_checkout_id, status,",
			"period_start, period_end, cancel_at_period_end",
			") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		].join(" "),
	)
		.bind(
			`polar-${subscriptionId}`,
			input.productId,
			input.organizationId,
			"customer-policy-refresh",
			subscriptionId,
			"checkout-policy-refresh",
			input.status,
			Date.now(),
			input.periodEnd,
			0,
		)
		.run();
}
