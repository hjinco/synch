import { BillingClient } from "../billing/client";
import { buildBillingWebPageUrl } from "../billing/web-url";
import { getServerDeployment } from "../config";
import { getSynchLocale } from "../i18n";
import type { SynchSubscriptionStatus } from "../ui/contracts";

const SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS = 30 * 1000;

export interface SynchSubscriptionServiceDeps {
  getApiBaseUrl: () => string;
  hasAuthenticatedSession: () => boolean;
  getAuthSessionToken: () => string;
  refreshUi: () => void;
}

export class SynchSubscriptionService {
  private readonly billingClient = new BillingClient();
  private subscriptionStatusCheckPromise: Promise<void> | null = null;
  private subscriptionStatusCheckedAt = 0;
  private subscriptionStatus: SynchSubscriptionStatus = {
    state: "idle",
  };

  constructor(private readonly deps: SynchSubscriptionServiceDeps) {}

  getSubscriptionStatus(): SynchSubscriptionStatus {
    return this.subscriptionStatus;
  }

  async ensureSubscriptionStatusCheck(): Promise<void> {
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
    window.open(url, "_blank", "noopener,noreferrer");
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

    this.subscriptionStatus = { state: "checking" };
    this.subscriptionStatusCheckPromise = this.billingClient
      .readBillingStatus(this.deps.getApiBaseUrl(), sessionToken)
      .then((status) => {
        this.subscriptionStatus = {
          state: "loaded",
          ...status,
        };
      })
      .catch((error) => {
        this.subscriptionStatus = {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.subscriptionStatusCheckedAt = Date.now();
        this.subscriptionStatusCheckPromise = null;
        this.deps.refreshUi();
      });

    await this.subscriptionStatusCheckPromise;
  }
}
