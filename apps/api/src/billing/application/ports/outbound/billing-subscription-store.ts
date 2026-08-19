import type {
	OrganizationSubscriptionStatus,
	PolarSubscriptionUpsertInput,
} from "../../dto/billing";

export interface BillingSubscriptionStore {
	readOrganizationSubscriptionStatuses(
		organizationId: string,
	): Promise<OrganizationSubscriptionStatus[]>;
	upsertPolarSubscription(input: PolarSubscriptionUpsertInput): Promise<void>;
}
