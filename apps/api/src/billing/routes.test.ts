import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
	getSession: vi.fn(),
}));

vi.mock("../auth", () => ({
	getSession: authMocks.getSession,
}));

import type { Auth } from "../auth";
import { apiError, onError } from "../errors";
import { registerBillingRoutes } from "./routes";
import type { BillingService } from "./service";

describe("billing routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("requires authentication for customer portal sessions", async () => {
		authMocks.getSession.mockResolvedValueOnce(null);
		const app = createTestApp();

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error: "unauthorized",
		});
	});

	it("creates customer portal sessions for authenticated users", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const billingService = fakeBillingService();
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				returnPath: "/ko/billing",
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			url: "https://polar.example/portal",
		});
		expect(billingService.createCustomerPortalSession).toHaveBeenCalledWith(
			"user-1",
			"/ko/billing",
		);
	});

	it("requires authentication for billing changes", async () => {
		authMocks.getSession.mockResolvedValueOnce(null);
		const app = createTestApp();

		const response = await app.request("/v1/billing/change", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				planId: "starter",
				billingInterval: "annual",
			}),
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error: "unauthorized",
		});
	});

	it("changes the subscription plan for authenticated users", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const status = {
			planId: "starter" as const,
			billingInterval: "annual" as const,
			active: true,
			status: "active",
			cancelAtPeriodEnd: false,
			periodEnd: "2027-05-08T00:00:00.000Z",
			canManageBilling: true,
		};
		const billingService = fakeBillingService({
			changeSubscriptionPlan: vi.fn(async () => status),
		});
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/change", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				planId: "starter",
				billingInterval: "annual",
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(status);
		expect(billingService.changeSubscriptionPlan).toHaveBeenCalledWith({
			userId: "user-1",
			planId: "starter",
			billingInterval: "annual",
		});
	});

	it("rejects billing change requests without a billing interval", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const billingService = fakeBillingService();
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/change", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				planId: "starter",
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "bad_request",
		});
		expect(billingService.changeSubscriptionPlan).not.toHaveBeenCalled();
	});

	it("returns not found when a billing customer is missing", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const billingService = fakeBillingService({
			createCustomerPortalSession: vi.fn(() => {
				throw apiError(
					404,
					"billing_customer_not_found",
					"billing customer was not found",
				);
			}),
		});
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			error: "billing_customer_not_found",
		});
	});
});

function createTestApp(billingService = fakeBillingService()): Hono {
	const app = new Hono();
	registerBillingRoutes(app, {
		auth: {} as Auth,
		billingService,
	});
	app.onError(onError);
	return app;
}

function fakeBillingService(overrides: Partial<BillingService> = {}): BillingService {
	return {
		createCheckout: vi.fn(),
		readBillingStatus: vi.fn(),
		changeSubscriptionPlan: vi.fn(),
		createCustomerPortalSession: vi.fn(async () => ({
			url: "https://polar.example/portal",
		})),
		...overrides,
	} as unknown as BillingService;
}
