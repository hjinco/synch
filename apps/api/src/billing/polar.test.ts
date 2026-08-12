import { beforeEach, describe, expect, it, vi } from "vitest";

const polarMocks = vi.hoisted(() => ({
	checkoutsCreate: vi.fn(),
	customerSessionsCreate: vi.fn(),
	Polar: vi.fn(function Polar(this: unknown, config: unknown) {
		Object.assign(this as object, {
			config,
			checkouts: {
				create: polarMocks.checkoutsCreate,
			},
			customerSessions: {
				create: polarMocks.customerSessionsCreate,
			},
		});
	}),
}));

vi.mock("@polar-sh/sdk", () => ({
	Polar: polarMocks.Polar,
}));

import { createPolarCheckout, createPolarCustomerPortalSession } from "./polar";

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
