import { beforeEach, describe, expect, it, vi } from "vitest";

const polarMocks = vi.hoisted(() => ({
	checkoutsCreate: vi.fn(),
	customersGetExternal: vi.fn(),
	customersCreate: vi.fn(),
	customerSessionsCreate: vi.fn(),
	subscriptionsUpdate: vi.fn(),
	Polar: vi.fn(function Polar(this: unknown, config: unknown) {
		Object.assign(this as object, {
			config,
			checkouts: {
				create: polarMocks.checkoutsCreate,
			},
			customers: {
				getExternal: polarMocks.customersGetExternal,
				create: polarMocks.customersCreate,
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
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound";
import { HTTPValidationError } from "@polar-sh/sdk/models/errors/httpvalidationerror";

import {
	createPolarCheckout,
	createPolarCustomerPortalSession,
	updatePolarSubscriptionProduct,
} from "./polar-provider";

describe("createPolarCheckout", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		polarMocks.customersGetExternal.mockResolvedValue({ id: "customer-1" });
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
			customerId: "customer-1",
			successUrl: "https://synch.example/billing/success?checkout_id={CHECKOUT_ID}&organizationId=org-1",
			metadata: {
				referenceId: "org-1",
				organizationId: "org-1",
				userId: "user-1",
				planId: "starter",
				billingInterval: "monthly",
			},
		});
	});

	const checkoutInput = {
		planId: "starter" as const,
		billingInterval: "monthly" as const,
		productId: "starter-product",
		organizationId: "org-1",
		userId: "user-1",
		email: "user@example.com",
	};
	const httpMeta = (status: number) => ({
		response: new Response(null, { status }),
		request: new Request("https://api.polar.sh/v1/customers/"),
		body: "",
	});
	const missingCustomer = () => new ResourceNotFound(
		{ error: "ResourceNotFound", detail: "Customer not found" }, httpMeta(404),
	);
	const duplicateEmail = () => new HTTPValidationError({
		detail: [{ loc: ["body", "email"], type: "value_error", msg: "A customer with this email address already exists." }],
	}, httpMeta(422));

	it("creates the organization customer before opening checkout", async () => {
		polarMocks.customersGetExternal.mockRejectedValueOnce(missingCustomer());
		polarMocks.customersCreate.mockResolvedValueOnce({ id: "new-customer" });
		polarMocks.checkoutsCreate.mockResolvedValueOnce({ id: "checkout-1", url: "https://polar.example/checkout-1" });

		await createPolarCheckout({ accessToken: "polar-token" }, checkoutInput);

		expect(polarMocks.customersGetExternal).toHaveBeenCalledWith({ externalId: "org-1" });
		expect(polarMocks.customersCreate).toHaveBeenCalledWith({ externalId: "org-1", email: "user@example.com" });
		expect(polarMocks.checkoutsCreate).toHaveBeenCalledWith(expect.objectContaining({ customerId: "new-customer" }));
		expect(polarMocks.checkoutsCreate.mock.calls[0][0]).not.toHaveProperty("customerEmail");
	});

	it("reuses a stored legacy customer even when another admin pays", async () => {
		polarMocks.checkoutsCreate.mockResolvedValueOnce({ id: "checkout-1", url: "https://polar.example/checkout-1" });

		await createPolarCheckout({ accessToken: "polar-token" }, { ...checkoutInput, polarCustomerId: "legacy-customer", email: "other-admin@example.com" });

		expect(polarMocks.customersGetExternal).not.toHaveBeenCalled();
		expect(polarMocks.customersCreate).not.toHaveBeenCalled();
		expect(polarMocks.checkoutsCreate).toHaveBeenCalledWith(expect.objectContaining({ customerId: "legacy-customer" }));
	});

	it("does not open checkout when the email belongs to another organization's customer", async () => {
		polarMocks.customersGetExternal.mockRejectedValue(missingCustomer());
		polarMocks.customersCreate.mockRejectedValueOnce(duplicateEmail());

		await expect(createPolarCheckout({ accessToken: "polar-token" }, checkoutInput))
			.rejects.toMatchObject({ code: "billing_email_unavailable" });

		expect(polarMocks.checkoutsCreate).not.toHaveBeenCalled();
	});

	it("reuses the same organization's customer after concurrent creation", async () => {
		polarMocks.customersGetExternal.mockRejectedValueOnce(missingCustomer())
			.mockResolvedValueOnce({ id: "concurrent-customer" });
		polarMocks.customersCreate.mockRejectedValueOnce(duplicateEmail());
		polarMocks.checkoutsCreate.mockResolvedValueOnce({ id: "checkout-1", url: "https://polar.example/checkout-1" });

		await createPolarCheckout({ accessToken: "polar-token" }, checkoutInput);

		expect(polarMocks.checkoutsCreate).toHaveBeenCalledWith(expect.objectContaining({ customerId: "concurrent-customer" }));
	});

	it("does not treat lookup outages as a missing customer", async () => {
		polarMocks.customersGetExternal.mockRejectedValueOnce(new Error("polar unavailable"));

		await expect(createPolarCheckout({ accessToken: "polar-token" }, checkoutInput)).rejects.toThrow("polar unavailable");

		expect(polarMocks.customersCreate).not.toHaveBeenCalled();
		expect(polarMocks.checkoutsCreate).not.toHaveBeenCalled();
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
			code: "subscription_canceled",
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
			code: "payment_failed",
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
			code: "subscription_locked",
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
