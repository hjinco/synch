import { stripTrailingSlash, type HttpClient } from "../http/request";

export type BillingPlanId = "free" | "starter" | "plus" | "self_hosted";
export type BillingInterval = "monthly" | "annual";

export interface BillingStatus {
  planId: BillingPlanId;
  billingInterval: BillingInterval | null;
  active: boolean;
  status: string;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
}

export class BillingClient {
  constructor(private readonly httpClient: HttpClient) {}

  async readBillingStatus(
    apiBaseUrl: string,
    sessionToken: string,
    organizationId?: string,
  ): Promise<BillingStatus> {
    const url = new URL(`${stripTrailingSlash(apiBaseUrl)}/v1/billing/status`);
    if (organizationId) url.searchParams.set("organizationId", organizationId);
    const response = await this.httpClient.request({
      url: url.toString(),
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
    });

    if (response.status !== 200) {
      throw new Error(`billing status lookup failed with status ${response.status}`);
    }

    return parseBillingStatus(response.json);
  }
}

export function parseBillingStatus(value: unknown): BillingStatus {
  if (!value || typeof value !== "object") {
    throw new Error("invalid billing status response");
  }

  const json = value as Partial<BillingStatus>;
  if (
    !isBillingPlanId(json.planId) ||
    !isBillingIntervalOrNull(json.billingInterval) ||
    typeof json.active !== "boolean" ||
    typeof json.status !== "string" ||
    typeof json.cancelAtPeriodEnd !== "boolean" ||
    !isStringOrNull(json.periodEnd)
  ) {
    throw new Error("invalid billing status response");
  }

  return {
    planId: json.planId,
    billingInterval: json.billingInterval,
    active: json.active,
    status: json.status,
    cancelAtPeriodEnd: json.cancelAtPeriodEnd,
    periodEnd: json.periodEnd,
  };
}

function isBillingPlanId(value: unknown): value is BillingPlanId {
  return value === "free" || value === "starter" || value === "plus" || value === "self_hosted";
}

function isBillingIntervalOrNull(value: unknown): value is BillingInterval | null {
  return value === "monthly" || value === "annual" || value === null;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}
