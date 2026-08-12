import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const polarMocks = vi.hoisted(() => ({
	createPolarCheckout: vi.fn(),
	createPolarCustomerPortalSession: vi.fn(),
}));

vi.mock("./polar", () => ({
	createPolarCheckout: polarMocks.createPolarCheckout,
	createPolarCustomerPortalSession: polarMocks.createPolarCustomerPortalSession,
}));

import type { BillingRepository } from "./repository";
import { BillingService } from "./service";
import type { SubscriptionProductIdsByPlanId } from "../subscription/policy";

describe("BillingService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates starter checkout for the user's default organization", async () => {
		polarMocks.createPolarCheckout.mockResolvedValueOnce({
			checkoutId: "checkout-1",
			url: "https://polar.example/checkout-1",
		});
		const repository = fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [],
		});
		const service = createBillingService(repository);

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
			}),
		).resolves.toEqual({
			checkoutId: "checkout-1",
			url: "https://polar.example/checkout-1",
		});
		expect(repository.readDefaultOrganizationIdForUser).toHaveBeenCalledWith("user-1");
		expect(polarMocks.createPolarCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				productIdsByPlanId: {
					starter: {
						monthly: "starter-monthly-product",
						annual: "starter-annual-product",
					},
				},
				wwwBaseUrl: "https://synch.example",
			}),
			{
				planId: "starter",
				billingInterval: "monthly",
				productId: "starter-monthly-product",
				organizationId: "org-1",
				userId: "user-1",
				email: "user@example.com",
			},
		);
	});

	it("creates annual starter checkout for the user's default organization", async () => {
		polarMocks.createPolarCheckout.mockResolvedValueOnce({
			checkoutId: "checkout-annual",
			url: "https://polar.example/checkout-annual",
		});
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [],
		}));

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
				billingInterval: "annual",
			}),
		).resolves.toEqual({
			checkoutId: "checkout-annual",
			url: "https://polar.example/checkout-annual",
		});
		expect(polarMocks.createPolarCheckout).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				planId: "starter",
				billingInterval: "annual",
				productId: "starter-annual-product",
			}),
		);
	});

	it("rejects starter checkout when the user has no organization", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: null,
			subscriptions: [],
		}));

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
			}),
		).rejects.toMatchObject({
			status: 400,
			cause: { code: "organization_required" },
		});
		expect(polarMocks.createPolarCheckout).not.toHaveBeenCalled();
	});

	it("rejects starter checkout when the organization already has starter access", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [
				{
					productId: "starter-monthly-product",
					status: "active",
					periodEnd: new Date(Date.now() + 60_000),
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				},
			],
		}));

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
			}),
		).rejects.toMatchObject({
			status: 409,
			cause: { code: "subscription_already_active" },
		});
		expect(polarMocks.createPolarCheckout).not.toHaveBeenCalled();
	});

	it("rejects checkout when the organization already has another paid plan access", async () => {
		const service = createBillingService(
			fakeBillingRepository({
				defaultOrganizationId: "org-1",
				subscriptions: [
					{
						productId: "pro-product",
						status: "active",
						periodEnd: new Date(Date.now() + 60_000),
						cancelAtPeriodEnd: false,
						updatedAt: new Date(),
					},
				],
			}),
			{
				starter: {
					monthly: "starter-monthly-product",
				},
				pro: {
					monthly: "pro-product",
				},
			} as never,
		);

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
			}),
		).rejects.toMatchObject({
			status: 409,
			cause: { code: "subscription_already_active" },
		});
		expect(polarMocks.createPolarCheckout).not.toHaveBeenCalled();
	});

	it("rejects checkout when the plan product id is not configured", async () => {
		const service = createBillingService(
			fakeBillingRepository({
				defaultOrganizationId: "org-1",
				subscriptions: [],
			}),
			{},
		);

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "starter",
			}),
		).rejects.toThrow();
		expect(polarMocks.createPolarCheckout).not.toHaveBeenCalled();
	});

	it("rejects checkout for plans that are not checkout enabled", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [],
		}));

		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "free",
			}),
		).rejects.toMatchObject({
			status: 400,
			cause: { code: "plan_not_available" },
		});
		await expect(
			service.createCheckout({
				userId: "user-1",
				email: "user@example.com",
				planId: "self_hosted",
			}),
		).rejects.toMatchObject({
			status: 400,
			cause: { code: "plan_not_available" },
		});
		expect(polarMocks.createPolarCheckout).not.toHaveBeenCalled();
	});

	it("reports starter billing status for a matching active product subscription", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [
				{
					productId: "starter-monthly-product",
					status: "active",
					periodEnd: new Date("2026-05-09T00:00:00.000Z"),
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				},
			],
		}));

		await expect(service.readBillingStatus("user-1")).resolves.toEqual({
			planId: "starter",
			billingInterval: "monthly",
			active: true,
			status: "active",
			cancelAtPeriodEnd: false,
			periodEnd: "2026-05-09T00:00:00.000Z",
		});
	});

	it("reports starter annual billing status for a matching annual product subscription", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [
				{
					productId: "starter-annual-product",
					status: "active",
					periodEnd: new Date("2026-05-09T00:00:00.000Z"),
					cancelAtPeriodEnd: true,
					updatedAt: new Date(),
				},
			],
		}));

		await expect(service.readBillingStatus("user-1")).resolves.toEqual({
			planId: "starter",
			billingInterval: "annual",
			active: true,
			status: "active",
			cancelAtPeriodEnd: true,
			periodEnd: "2026-05-09T00:00:00.000Z",
		});
	});

	it("falls back to free billing status for unknown products", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			subscriptions: [
				{
					productId: "other-product",
					status: "active",
					periodEnd: new Date("2026-05-09T00:00:00.000Z"),
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				},
			],
		}));

		await expect(service.readBillingStatus("user-1")).resolves.toEqual({
			planId: "free",
			billingInterval: null,
			active: false,
			status: "active",
			cancelAtPeriodEnd: false,
			periodEnd: "2026-05-09T00:00:00.000Z",
		});
	});

	it("creates a customer portal session for the user's default organization", async () => {
		polarMocks.createPolarCustomerPortalSession.mockResolvedValueOnce({
			url: "https://polar.example/portal",
		});
		const repository = fakeBillingRepository({
			defaultOrganizationId: "org-1",
			polarCustomerId: "customer-1",
			subscriptions: [],
		});
		const service = createBillingService(repository);

		await expect(
			service.createCustomerPortalSession("user-1", "/ko/billing"),
		).resolves.toEqual({
			url: "https://polar.example/portal",
		});
		expect(repository.readDefaultOrganizationIdForUser).toHaveBeenCalledWith("user-1");
		expect(repository.readOrganizationPolarCustomerId).toHaveBeenCalledWith("org-1");
		expect(polarMocks.createPolarCustomerPortalSession).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: "polar-token",
				wwwBaseUrl: "https://synch.example",
			}),
			{
				polarCustomerId: "customer-1",
				returnUrl: "https://synch.example/ko/billing",
			},
		);
	});

	it("rejects customer portal sessions when the user has no organization", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: null,
			subscriptions: [],
		}));

		await expect(service.createCustomerPortalSession("user-1")).rejects.toMatchObject({
			status: 400,
			cause: { code: "organization_required" },
		});
		expect(polarMocks.createPolarCustomerPortalSession).not.toHaveBeenCalled();
	});

	it("rejects customer portal sessions when the organization has no Polar customer", async () => {
		const service = createBillingService(fakeBillingRepository({
			defaultOrganizationId: "org-1",
			polarCustomerId: null,
			subscriptions: [],
		}));

		await expect(service.createCustomerPortalSession("user-1")).rejects.toMatchObject({
			status: 404,
			cause: { code: "billing_customer_not_found" },
		});
		expect(polarMocks.createPolarCustomerPortalSession).not.toHaveBeenCalled();
	});

	it("propagates portal session failures from the Polar client", async () => {
		// Synthetic fixture error: verifies the failure is passed through unwrapped.
		polarMocks.createPolarCustomerPortalSession.mockRejectedValueOnce(
			new Error("simulated polar failure"),
		);
		const service = createBillingService(
			fakeBillingRepository({
				defaultOrganizationId: "org-1",
				polarCustomerId: "customer-1",
				subscriptions: [],
			}),
			undefined,
			{ accessToken: undefined },
		);

		await expect(service.createCustomerPortalSession("user-1")).rejects.toThrow(
			"simulated polar failure",
		);
	});
});

function createBillingService(
	repository: BillingRepository,
	productIdsByPlanId: SubscriptionProductIdsByPlanId = {
		starter: {
			monthly: "starter-monthly-product",
			annual: "starter-annual-product",
		},
	},
	configOverrides: Partial<ConstructorParameters<typeof BillingService>[1]> = {},
): BillingService {
	return new BillingService(repository, {
		accessToken: "polar-token",
		productIdsByPlanId,
		webhookSecret: "webhook-secret",
		publicBaseUrl: "https://api.synch.example",
		wwwBaseUrl: "https://synch.example",
		...configOverrides,
	});
}

function fakeBillingRepository(input: {
	defaultOrganizationId: string | null;
	polarCustomerId?: string | null;
	subscriptions: Awaited<
		ReturnType<BillingRepository["readOrganizationSubscriptionStatuses"]>
	>;
}): BillingRepository {
	return {
		readDefaultOrganizationIdForUser: vi.fn(async () => input.defaultOrganizationId),
		readOrganizationPolarCustomerId: vi.fn(async () => input.polarCustomerId ?? null),
		readOrganizationSubscriptionStatuses: vi.fn(async () => input.subscriptions),
	} as unknown as BillingRepository;
}
