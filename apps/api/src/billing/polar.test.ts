import { beforeEach, describe, expect, it, vi } from "vitest";

const polarMocks = vi.hoisted(() => ({
	checkoutsCreate: vi.fn(),
	customerSessionsCreate: vi.fn(),
	subscriptionsUpdate: vi.fn(),
	Polar: vi.fn(function Polar(this: unknown, config: unknown) {
		Object.assign(this as object, {
			config,
			checkouts: {
				create: polarMocks.checkoutsCreate,
			},
			customerSessions: {
				create: polarMocks.customerSessionsCreate,
			},
			subscriptions: {
				update: polarMocks.subscriptionsUpdate,
			},
		});
	}),
}));

vi.mock("@polar-sh/sdk", () => ({
	Polar: polarMocks.Polar,
}));

import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked";

import {
	createPolarCheckout,
	createPolarCustomerPortalSession,
	updatePolarSubscriptionProduct,
} from "./polar";

describe("createPolarCheckout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a starter checkout with organization metadata", async () => {
		polarMocks.checkoutsCreate.mockResolvedValueOnce({
			id: "checkout-1",
			url: "https://polar.example/checkout-1",
		});

		await expect(
			createPolarCheckout(
				{
					accessToken: "polar-token",
					wwwBaseUrl: "https://synch.example",
					sandbox: true,
				},
				{
					planId: "starter",
					billingInterval: "monthly",
					productId: "starter-product",
					organizationId: "org-1",
					userId: "user-1",
					email: "user@example.com",
				},
			),
		).resolves.toEqual({
			checkoutId: "checkout-1",
			url: "https://polar.example/checkout-1",
		});

		expect(polarMocks.Polar).toHaveBeenCalledWith({
			accessToken: "polar-token",
			server: "sandbox",
		});
		expect(polarMocks.checkoutsCreate).toHaveBeenCalledWith({
			products: ["starter-product"],
			externalCustomerId: "user-1",
			customerEmail: "user@example.com",
			successUrl: "https://synch.example/billing/success?checkout_id={CHECKOUT_ID}",
			metadata: {
				referenceId: "org-1",
				organizationId: "org-1",
				userId: "user-1",
				planId: "starter",
				billingInterval: "monthly",
			},
		});
	});

	it("requires a Polar access token", async () => {
		await expect(
			createPolarCheckout(
				{
					wwwBaseUrl: "https://synch.example",
				},
				{
					planId: "starter",
					billingInterval: "monthly",
					productId: "starter-product",
					organizationId: "org-1",
					userId: "user-1",
					email: "user@example.com",
				},
			),
		).rejects.toThrow();
		expect(polarMocks.checkoutsCreate).not.toHaveBeenCalled();
	});

	it("throws Polar checkout failures", async () => {
		polarMocks.checkoutsCreate.mockRejectedValueOnce(new Error("polar unavailable"));

		await expect(
			createPolarCheckout(
				{
					accessToken: "polar-token",
					wwwBaseUrl: "https://synch.example",
				},
				{
					planId: "starter",
					billingInterval: "monthly",
					productId: "starter-product",
					organizationId: "org-1",
					userId: "user-1",
					email: "user@example.com",
				},
			),
		).rejects.toThrow("polar unavailable");
	});

	it("creates a customer portal session", async () => {
		polarMocks.customerSessionsCreate.mockResolvedValueOnce({
			customerPortalUrl: "https://polar.example/portal/session-1",
		});

		await expect(
			createPolarCustomerPortalSession(
				{
					accessToken: "polar-token",
					sandbox: true,
				},
				{
					polarCustomerId: "customer-1",
					returnUrl: "https://synch.example/billing",
				},
			),
		).resolves.toEqual({
			url: "https://polar.example/portal/session-1",
		});

		expect(polarMocks.Polar).toHaveBeenCalledWith({
			accessToken: "polar-token",
			server: "sandbox",
		});
		expect(polarMocks.customerSessionsCreate).toHaveBeenCalledWith({
			customerId: "customer-1",
			returnUrl: "https://synch.example/billing",
		});
	});

	it("requires a Polar access token for customer portal sessions", async () => {
		await expect(
			createPolarCustomerPortalSession(
				{},
				{
					polarCustomerId: "customer-1",
					returnUrl: "https://synch.example/billing",
				},
			),
		).rejects.toThrow();
		expect(polarMocks.customerSessionsCreate).not.toHaveBeenCalled();
	});
});

describe("updatePolarSubscriptionProduct", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("switches the subscription product with immediate proration", async () => {
		polarMocks.subscriptionsUpdate.mockResolvedValueOnce({
			id: "sub-1",
			productId: "starter-annual-product",
			customerId: "customer-1",
			checkoutId: "checkout-1",
			status: "active",
			currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2027-05-01T00:00:00.000Z"),
			cancelAtPeriodEnd: false,
			metadata: {
				referenceId: "org-1",
				organizationId: "org-1",
			},
		});

		await expect(
			updatePolarSubscriptionProduct(
				{
					accessToken: "polar-token",
					sandbox: true,
				},
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).resolves.toEqual({
			id: "polar-sub-sub-1",
			productId: "starter-annual-product",
			organizationId: "org-1",
			polarCustomerId: "customer-1",
			polarSubscriptionId: "sub-1",
			polarCheckoutId: "checkout-1",
			status: "active",
			periodStart: new Date("2026-05-01T00:00:00.000Z"),
			periodEnd: new Date("2027-05-01T00:00:00.000Z"),
			cancelAtPeriodEnd: false,
		});

		expect(polarMocks.Polar).toHaveBeenCalledWith({
			accessToken: "polar-token",
			server: "sandbox",
		});
		expect(polarMocks.subscriptionsUpdate).toHaveBeenCalledWith({
			id: "sub-1",
			subscriptionUpdate: {
				productId: "starter-annual-product",
				prorationBehavior: "invoice",
			},
		});
	});

	it("uses the trusted organization when the Polar response has no metadata", async () => {
		polarMocks.subscriptionsUpdate.mockResolvedValueOnce({
			id: "sub-1",
			productId: "starter-annual-product",
			customerId: "customer-1",
			checkoutId: "checkout-1",
			status: "active",
			currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2027-05-01T00:00:00.000Z"),
			cancelAtPeriodEnd: false,
			metadata: {},
		});

		await expect(
			updatePolarSubscriptionProduct(
				{ accessToken: "polar-token" },
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).resolves.toMatchObject({
			organizationId: "org-1",
			productId: "starter-annual-product",
			polarSubscriptionId: "sub-1",
		});
	});

	it("requires a Polar access token", async () => {
		await expect(
			updatePolarSubscriptionProduct(
				{},
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).rejects.toThrow();
		expect(polarMocks.subscriptionsUpdate).not.toHaveBeenCalled();
	});

	it("maps already canceled subscription failures", async () => {
		polarMocks.subscriptionsUpdate.mockRejectedValueOnce(
			new AlreadyCanceledSubscription(
				{
					error: "AlreadyCanceledSubscription",
					detail: "subscription is canceled",
				},
				polarErrorHttpMeta(),
			),
		);

		await expect(
			updatePolarSubscriptionProduct(
				{ accessToken: "polar-token" },
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).rejects.toMatchObject({
			status: 409,
			cause: { code: "subscription_canceled" },
		});
	});

	it("maps payment failures", async () => {
		polarMocks.subscriptionsUpdate.mockRejectedValueOnce(
			new PaymentFailed(
				{
					error: "PaymentFailed",
					detail: "card declined",
				},
				polarErrorHttpMeta(),
			),
		);

		await expect(
			updatePolarSubscriptionProduct(
				{ accessToken: "polar-token" },
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).rejects.toMatchObject({
			status: 402,
			cause: { code: "payment_failed" },
		});
	});

	it("maps locked subscription failures", async () => {
		polarMocks.subscriptionsUpdate.mockRejectedValueOnce(
			new SubscriptionLocked(
				{
					error: "SubscriptionLocked",
					detail: "subscription is locked",
				},
				polarErrorHttpMeta(),
			),
		);

		await expect(
			updatePolarSubscriptionProduct(
				{ accessToken: "polar-token" },
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).rejects.toMatchObject({
			status: 409,
			cause: { code: "subscription_locked" },
		});
	});

	it("rethrows other Polar failures", async () => {
		polarMocks.subscriptionsUpdate.mockRejectedValueOnce(
			new Error("polar unavailable"),
		);

		await expect(
			updatePolarSubscriptionProduct(
				{ accessToken: "polar-token" },
				{
					organizationId: "org-1",
					polarSubscriptionId: "sub-1",
					productId: "starter-annual-product",
				},
			),
		).rejects.toThrow("polar unavailable");
	});
});

function polarErrorHttpMeta(): {
	response: Response;
	request: Request;
	body: string;
} {
	return {
		response: new Response(null, { status: 400 }),
		request: new Request("https://api.polar.example/v1/subscriptions/sub-1"),
		body: "",
	};
}
