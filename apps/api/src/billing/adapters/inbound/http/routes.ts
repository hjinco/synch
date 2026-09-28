import { Hono } from "hono";
import { z } from "zod";

import type { SessionReader } from "../../../../auth/session";
import { apiError } from "../../../../errors";
import { createEnsureAuthenticatedSession } from "../../../../platform/http/authenticated-session";
import {
	SUBSCRIPTION_BILLING_INTERVALS,
	SUBSCRIPTION_PLAN_IDS,
	type SubscriptionBillingInterval,
	type SubscriptionPlanId,
} from "../../../../subscription/application";
import type { BillingService } from "../../../application";

const checkoutRequestSchema = z.object({
	organizationId: z.string().min(1).optional(),
	billingInterval: z.enum(SUBSCRIPTION_BILLING_INTERVALS).optional(),
	planId: z.enum(SUBSCRIPTION_PLAN_IDS).optional(),
}).strict();

const changeRequestSchema = z.object({
	organizationId: z.string().min(1).optional(),
	billingInterval: z.enum(SUBSCRIPTION_BILLING_INTERVALS),
	planId: z.enum(SUBSCRIPTION_PLAN_IDS),
}).strict();

const portalRequestSchema = z.object({
	organizationId: z.string().min(1).optional(),
	returnPath: z.string().optional(),
}).strict();

export function registerBillingRoutes(
	app: Hono,
	deps: { sessionReader: SessionReader; billingService: BillingService },
): void {
	const ensureAuthenticatedSession = createEnsureAuthenticatedSession(deps.sessionReader);

	app.post("/v1/billing/checkout", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const { billingInterval, planId, organizationId } = await readCheckoutRequestPlanId(c.req.raw);
		const checkout = await deps.billingService.createCheckout({
			userId: user.id,
			organizationId,
			email: user.email,
			planId,
			billingInterval,
		});

		return c.json(checkout);
	});

	app.post("/v1/billing/change", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const { billingInterval, planId, organizationId } = await readChangeRequest(c.req.raw);
		const status = await deps.billingService.changeSubscriptionPlan({
			userId: user.id,
			organizationId,
			planId,
			billingInterval,
		});

		return c.json(status);
	});

	app.get("/v1/billing/status", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const status = await deps.billingService.readBillingStatus(user.id, c.req.query("organizationId"));

		return c.json(status);
	});

	app.post("/v1/billing/portal", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const { returnPath, organizationId } = await readPortalRequest(c.req.raw);
		const portal = await deps.billingService.createCustomerPortalSession(
			user.id,
			returnPath,
			organizationId ?? c.req.query("organizationId"),
		);

		return c.json(portal);
	});
}

async function readPortalRequest(request: Request): Promise<{ returnPath: string; organizationId?: string }> {
	if (!request.headers.get("content-type")) {
		return { returnPath: "/billing" };
	}

	let json: unknown;
	try {
		json = await request.json();
	} catch {
		throw apiError(400, "bad_request", "invalid billing portal request");
	}

	const parsed = portalRequestSchema.safeParse(json);
	if (!parsed.success) {
		throw apiError(400, "bad_request", "invalid billing portal request");
	}

	const returnPath = parsed.data.returnPath ?? "/billing";
	if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
		throw apiError(400, "bad_request", "invalid billing portal return path");
	}

	return { returnPath, organizationId: parsed.data.organizationId };
}

async function readChangeRequest(request: Request): Promise<{
	organizationId?: string;
	billingInterval: SubscriptionBillingInterval;
	planId: SubscriptionPlanId;
}> {
	let json: unknown;
	try {
		json = await request.json();
	} catch {
		throw apiError(400, "bad_request", "invalid billing change request");
	}

	const parsed = changeRequestSchema.safeParse(json);
	if (!parsed.success) {
		throw apiError(400, "bad_request", "invalid billing change request");
	}

	return parsed.data;
}

async function readCheckoutRequestPlanId(request: Request): Promise<{
	organizationId?: string;
	billingInterval: SubscriptionBillingInterval;
	planId: SubscriptionPlanId;
}> {
	if (!request.headers.get("content-type")) {
		return { planId: "starter", billingInterval: "monthly" };
	}

	let json: unknown;
	try {
		json = await request.json();
	} catch {
		throw apiError(400, "bad_request", "invalid checkout request");
	}

	const parsed = checkoutRequestSchema.safeParse(json);
	if (!parsed.success) {
		throw apiError(400, "bad_request", "invalid checkout request");
	}

	return {
		planId: parsed.data.planId ?? "starter",
		organizationId: parsed.data.organizationId,
		billingInterval: parsed.data.billingInterval ?? "monthly",
	};
}
