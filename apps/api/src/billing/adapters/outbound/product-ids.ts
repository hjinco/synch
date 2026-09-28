import type { SubscriptionProductIdsByPlanId } from "../../../subscription/application";

type PolarProductIdEnv = {
	POLAR_PLUS_MONTHLY_PRODUCT_ID?: string;
	POLAR_PLUS_ANNUAL_PRODUCT_ID?: string;
	POLAR_STARTER_MONTHLY_PRODUCT_ID?: string;
	POLAR_STARTER_ANNUAL_PRODUCT_ID?: string;
};

export function readPolarProductIdsByPlanId(
	env: PolarProductIdEnv,
): SubscriptionProductIdsByPlanId {
	return {
		plus: {
			monthly: env.POLAR_PLUS_MONTHLY_PRODUCT_ID,
			annual: env.POLAR_PLUS_ANNUAL_PRODUCT_ID,
		},
		starter: {
			monthly: env.POLAR_STARTER_MONTHLY_PRODUCT_ID,
			annual: env.POLAR_STARTER_ANNUAL_PRODUCT_ID,
		},
	};
}
