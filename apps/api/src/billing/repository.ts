import { asc, desc, eq } from "drizzle-orm";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";

export type PolarSubscriptionUpsertInput = {
	id: string;
	productId: string;
	organizationId: string;
	polarCustomerId: string;
	polarSubscriptionId: string;
	polarCheckoutId: string | null;
	status: string;
	periodStart: Date | null;
	periodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
};

export type OrganizationSubscriptionStatus = {
	productId: string;
	status: string;
	periodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	updatedAt: Date;
};

export class BillingRepository {
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

	async readOrganizationSubscriptionStatuses(
		organizationId: string,
	): Promise<OrganizationSubscriptionStatus[]> {
		return await this.db
			.select({
				productId: schema.polarSubscription.productId,
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
