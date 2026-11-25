import { ContextRequestCache } from "./context-request-cache";
import { BillingClient } from "@synch/sync-client/billing";
import { defaultHttpClient } from "../adapters/http";
import { buildBillingWebPageUrl, type BillingWebPage } from "./billing-web-url";
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
  private subscriptionStatus: SynchSubscriptionStatus = {
    state: "idle",
  };

  private readonly cache = new ContextRequestCache({
    getContextKey: () => JSON.stringify([
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      this.deps.hasAuthenticatedSession(),
      this.deps.getOrganizationId?.(),
    ]),
    intervalMs: SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS,
    onInvalidate: () => { this.subscriptionStatus = { state: "idle" }; },
    onSettled: () => this.deps.refreshUi(),
  });

  constructor(private readonly deps: SynchSubscriptionServiceDeps) {}

  getSubscriptionStatus(): SynchSubscriptionStatus {
    this.cache.syncContext();
    return this.subscriptionStatus;
  }

  async ensureSubscriptionStatusCheck(): Promise<void> {
    this.cache.syncContext();
    if (
      !this.deps.hasAuthenticatedSession() ||
      getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud"
    ) {
      this.clearSubscriptionStatus();
      return;
    }

    await this.checkSubscriptionStatus();
  }

  async retrySubscriptionStatusCheck(): Promise<void> {
    this.cache.syncContext();
    if (
      !this.deps.hasAuthenticatedSession() ||
      getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud"
    ) {
      this.clearSubscriptionStatus();
      return;
    }

    await this.checkSubscriptionStatus(true);
  }

  clearSubscriptionStatus(): void {
    this.cache.invalidate();
  }

  openBillingManagementPage(): void {
    this.openBillingWebPage("billing");
  }

  openUpgradePage(): void {
    this.openBillingWebPage("upgrade");
  }

  private openBillingWebPage(page: BillingWebPage): void {
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

  private async checkSubscriptionStatus(force = false): Promise<void> {
    const sessionToken = this.deps.getAuthSessionToken().trim();
    if (!sessionToken) {
      this.clearSubscriptionStatus();
      return;
    }

    await this.cache.run(
      () => {
        this.subscriptionStatus = { state: "checking" };
        return this.billingClient.readBillingStatus(
          this.deps.getApiBaseUrl(),
          sessionToken,
          this.deps.getOrganizationId?.(),
        );
      },
      (status) => {
        this.subscriptionStatus = { state: "loaded", ...status };
      },
      (error) => {
        this.subscriptionStatus = {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      },
      force,
    );
  }
}
