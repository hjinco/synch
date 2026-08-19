import { desc, eq } from "drizzle-orm";

import type { AppDb } from "../../../db/client";
import * as schema from "../../../db/d1";
import type { SubscriptionPolicyData } from "../../application/dto/subscription-policy-data";
import type { SubscriptionPolicyDataReader } from "../../application/ports/outbound/subscription-policy-data-reader";

export class DrizzleSubscriptionPolicyDataReader
	implements SubscriptionPolicyDataReader
{
	constructor(private readonly db: AppDb) {}

	async readOrganizationPolicyData(
		organizationId: string,
	): Promise<SubscriptionPolicyData> {
		const subscriptions = await this.db
			.select({
				productId: schema.polarSubscription.productId,
				status: schema.polarSubscription.status,
				periodEnd: schema.polarSubscription.periodEnd,
			})
			.from(schema.polarSubscription)
			.where(eq(schema.polarSubscription.organizationId, organizationId))
			.orderBy(desc(schema.polarSubscription.periodEnd))
			.limit(10);

		const organizations = await this.db
			.select({
				syncedVaultsOverride: schema.organization.syncedVaultsOverride,
			})
			.from(schema.organization)
			.where(eq(schema.organization.id, organizationId))
			.limit(1);

		return {
			subscriptions,
			organization: organizations[0]
				? { syncedVaults: organizations[0].syncedVaultsOverride }
				: null,
		};
	}
}
