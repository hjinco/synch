import { and, asc, desc, eq } from "drizzle-orm";

import type { AppDb } from "../../../db/client";
import * as schema from "../../../db/d1";
import type { OrganizationSubscriptionStatus, PolarSubscriptionUpsertInput } from "../../application/dto/billing";
import type { BillingAccountStore } from "../../application/ports/outbound/billing-account-store";
import type { BillingSubscriptionStore } from "../../application/ports/outbound/billing-subscription-store";

export class DrizzleBillingStore implements BillingAccountStore, BillingSubscriptionStore {
	constructor(private readonly db: AppDb) {}

	async readDefaultOrganizationIdForUser(userId: string): Promise<string | null> {
		const rows = await this.db
			.select({
				organizationId: schema.member.organizationId,
			})
			.from(schema.member)
			.where(eq(schema.member.userId, userId))
			.orderBy(asc(schema.member.createdAt))
			.limit(1);

		return rows[0]?.organizationId ?? null;
	}

	async readOrganizationRoleForUser(
		userId: string,
		organizationId: string,
	): Promise<string | null> {
		const rows = await this.db
			.select({
				role: schema.member.role,
			})
			.from(schema.member)
			.where(
				and(
					eq(schema.member.userId, userId),
					eq(schema.member.organizationId, organizationId),
				),
			)
			.limit(1);

		return rows[0]?.role ?? null;
	}

	async readOrganizationSubscriptionStatuses(
		organizationId: string,
	): Promise<OrganizationSubscriptionStatus[]> {
		return await this.db
			.select({
				productId: schema.polarSubscription.productId,
				polarSubscriptionId: schema.polarSubscription.polarSubscriptionId,
				status: schema.polarSubscription.status,
				periodEnd: schema.polarSubscription.periodEnd,
				cancelAtPeriodEnd: schema.polarSubscription.cancelAtPeriodEnd,
				updatedAt: schema.polarSubscription.updatedAt,
			})
			.from(schema.polarSubscription)
			.where(eq(schema.polarSubscription.organizationId, organizationId))
			.orderBy(desc(schema.polarSubscription.updatedAt))
			.limit(10);
	}

	async readOrganizationPolarCustomerId(
		organizationId: string,
	): Promise<string | null> {
		const rows = await this.db
			.select({
				polarCustomerId: schema.organization.polarCustomerId,
			})
			.from(schema.organization)
			.where(eq(schema.organization.id, organizationId))
			.limit(1);

		return rows[0]?.polarCustomerId ?? null;
	}

	async upsertPolarSubscription(input: PolarSubscriptionUpsertInput): Promise<void> {
		await this.db
			.insert(schema.polarSubscription)
			.values({
				id: input.id,
				productId: input.productId,
				organizationId: input.organizationId,
				polarCustomerId: input.polarCustomerId,
				polarSubscriptionId: input.polarSubscriptionId,
				polarCheckoutId: input.polarCheckoutId,
				status: input.status,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				cancelAtPeriodEnd: input.cancelAtPeriodEnd,
			})
			.onConflictDoUpdate({
				target: schema.polarSubscription.polarSubscriptionId,
				set: {
					productId: input.productId,
					organizationId: input.organizationId,
					polarCustomerId: input.polarCustomerId,
					polarCheckoutId: input.polarCheckoutId,
					status: input.status,
					periodStart: input.periodStart,
					periodEnd: input.periodEnd,
					cancelAtPeriodEnd: input.cancelAtPeriodEnd,
					updatedAt: new Date(),
				},
			});

		await this.db
			.update(schema.organization)
			.set({
				polarCustomerId: input.polarCustomerId,
			})
			.where(eq(schema.organization.id, input.organizationId));
	}

}
