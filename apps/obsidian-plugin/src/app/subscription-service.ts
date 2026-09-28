import { BillingClient } from "@synch/sync-client/billing";
import { defaultHttpClient } from "../adapters/http";
import { buildBillingWebPageUrl } from "./billing-web-url";
import { getServerDeployment } from "../config";
import { getSynchLocale } from "../i18n";
import { openExternalUrl } from "../adapters/external-browser";
import type { SynchSubscriptionStatus } from "../ui/contracts";

const SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS = 30 * 1000;

export interface SynchSubscriptionServiceDeps {
  getOrganizationId?: () => string | undefined;
  getApiBaseUrl: () => string;
  hasAuthenticatedSession: () => boolean;
  getAuthSessionToken: () => string;
  refreshUi: () => void;
}

export class SynchSubscriptionService {
  private readonly billingClient = new BillingClient(defaultHttpClient);
  private contextKey = "";
  private subscriptionStatusCheckPromise: Promise<void> | null = null;
  private subscriptionStatusCheckedAt = 0;
  private subscriptionStatus: SynchSubscriptionStatus = {
    state: "idle",
  };

  constructor(private readonly deps: SynchSubscriptionServiceDeps) {}

  getSubscriptionStatus(): SynchSubscriptionStatus {
    this.checkContext();
    return this.subscriptionStatus;
  }

  async ensureSubscriptionStatusCheck(): Promise<void> {
    this.checkContext();
    if (
      !this.deps.hasAuthenticatedSession() ||
      getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud"
    ) {
      this.clearSubscriptionStatus();
      return;
    }

    if (this.subscriptionStatusCheckPromise) {
      await this.subscriptionStatusCheckPromise;
      return;
    }

    if (
      this.subscriptionStatus.state !== "idle" &&
      Date.now() - this.subscriptionStatusCheckedAt <
        SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS
    ) {
      return;
    }

    await this.checkSubscriptionStatus();
  }

  async retrySubscriptionStatusCheck(): Promise<void> {
    this.checkContext();
    if (
      !this.deps.hasAuthenticatedSession() ||
      getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud"
    ) {
      this.clearSubscriptionStatus();
      return;
    }

    await this.checkSubscriptionStatus();
  }

  clearSubscriptionStatus(): void {
    this.subscriptionStatus = { state: "idle" };
    this.subscriptionStatusCheckedAt = 0;
    this.subscriptionStatusCheckPromise = null;
  }

  openBillingManagementPage(): void {
    this.openBillingWebPage("billing");
  }

  openPricingPage(): void {
    this.openBillingWebPage("pricing");
  }

  private openBillingWebPage(page: "pricing" | "billing"): void {
    const url = buildBillingWebPageUrl(
      this.deps.getApiBaseUrl(),
      page,
      getSynchLocale(),
    );
    const scopedUrl = new URL(url);
    const organizationId = this.deps.getOrganizationId?.();
    if (organizationId)
      scopedUrl.searchParams.set("organizationId", organizationId);
    openExternalUrl(scopedUrl.toString());
  }

  private checkContext(): void {
    const next = JSON.stringify([
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      this.deps.getOrganizationId?.(),
    ]);
    if (next !== this.contextKey) {
      this.contextKey = next;
      this.clearSubscriptionStatus();
    }
  }

  private async checkSubscriptionStatus(): Promise<void> {
    if (this.subscriptionStatusCheckPromise) {
      await this.subscriptionStatusCheckPromise;
      return;
    }

    const sessionToken = this.deps.getAuthSessionToken().trim();
    if (!sessionToken) {
      this.clearSubscriptionStatus();
      return;
    }

    const contextKey = this.contextKey;
    this.subscriptionStatus = { state: "checking" };
    this.subscriptionStatusCheckPromise = this.billingClient
      .readBillingStatus(
        this.deps.getApiBaseUrl(),
        sessionToken,
        this.deps.getOrganizationId?.(),
      )
      .then((status) => {
        if (contextKey !== this.contextKey) return;
        this.subscriptionStatus = {
          state: "loaded",
          ...status,
        };
      })
      .catch((error) => {
        if (contextKey !== this.contextKey) return;
        this.subscriptionStatus = {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        if (contextKey !== this.contextKey) return;
        this.subscriptionStatusCheckedAt = Date.now();
        this.subscriptionStatusCheckPromise = null;
        this.deps.refreshUi();
      });

    await this.subscriptionStatusCheckPromise;
  }
}
