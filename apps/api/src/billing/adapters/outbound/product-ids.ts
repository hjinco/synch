import type { SubscriptionProductIdsByPlanId } from "../../../subscription/application";

type PolarProductIdEnv = {
	POLAR_STARTER_MONTHLY_PRODUCT_ID?: string;
	POLAR_STARTER_ANNUAL_PRODUCT_ID?: string;
};

export function readPolarProductIdsByPlanId(
	env: PolarProductIdEnv,
): SubscriptionProductIdsByPlanId {
	return {
		starter: {
			monthly: env.POLAR_STARTER_MONTHLY_PRODUCT_ID,
			annual: env.POLAR_STARTER_ANNUAL_PRODUCT_ID,
		},
	};
}
