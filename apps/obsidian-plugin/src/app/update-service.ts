import { getServerDeployment } from "../config";
import { t } from "../i18n";
import type {
  SynchCommunityPluginUpdateStatus,
  SynchServerCompatibilityStatus,
} from "../ui/contracts";
import {
  SUPPORTED_SYNCH_API_MAJOR,
  SynchServerPluginVersionChecker,
} from "./server-version-checker";
import { SynchPluginUpdateChecker } from "./update-checker";

const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SynchPluginUpdateServiceDeps {
  getApiBaseUrl: () => string;
  getPluginVersion: () => string;
  refreshUi: () => void;
  onPluginUpdateRequired: () => void;
  notify: (message: string, timeout?: number) => void;
}

export class SynchPluginUpdateService {
  private readonly pluginUpdateChecker = new SynchPluginUpdateChecker();
  private readonly serverPluginVersionChecker = new SynchServerPluginVersionChecker();
  private communityPluginUpdateCheckPromise: Promise<void> | null = null;
  private communityPluginUpdateCheckedAt = 0;
  private communityPluginUpdateStatus: SynchCommunityPluginUpdateStatus = {
    state: "idle",
    currentVersion: this.deps.getPluginVersion(),
  };
  private serverCompatibilityStatus: SynchServerCompatibilityStatus = {
    state: "idle",
  };

  constructor(private readonly deps: SynchPluginUpdateServiceDeps) {}

  getCommunityPluginUpdateStatus(): SynchCommunityPluginUpdateStatus {
    return this.communityPluginUpdateStatus;
  }

  getServerCompatibilityStatus(): SynchServerCompatibilityStatus {
    return this.serverCompatibilityStatus;
  }

  isPluginUpdateRequired(): boolean {
    return (
      this.serverCompatibilityStatus.state === "update_required" ||
      this.serverCompatibilityStatus.state === "incompatible"
    );
  }

  getPluginUpdateRequiredMessage(): string {
    if (
      this.serverCompatibilityStatus.state !== "update_required" &&
      this.serverCompatibilityStatus.state !== "incompatible"
    ) {
      return t("plugin.updateRequiredStatus");
    }

    return this.serverCompatibilityStatus.message;
  }

  async ensureCommunityPluginUpdateCheck(): Promise<void> {
    if (getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud") {
      this.clearCommunityPluginUpdateStatus();
      return;
    }

    if (this.communityPluginUpdateCheckPromise) {
      await this.communityPluginUpdateCheckPromise;
      return;
    }

    if (
      this.communityPluginUpdateStatus.state !== "idle" &&
      Date.now() - this.communityPluginUpdateCheckedAt < PLUGIN_UPDATE_CHECK_INTERVAL_MS
    ) {
      return;
    }

    await this.checkCommunityPluginUpdate();
  }

  async retryCommunityPluginUpdateCheck(): Promise<void> {
    if (getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud") {
      this.clearCommunityPluginUpdateStatus();
      return;
    }

    await this.checkCommunityPluginUpdate();
  }

  clearCommunityPluginUpdateStatus(): void {
    this.communityPluginUpdateStatus = {
      state: "idle",
      currentVersion: this.deps.getPluginVersion(),
    };
    this.communityPluginUpdateCheckedAt = 0;
    this.communityPluginUpdateCheckPromise = null;
  }

  async checkServerCompatibility(): Promise<void> {
    try {
      const status = await this.serverPluginVersionChecker.check(
        this.deps.getApiBaseUrl(),
        this.deps.getPluginVersion(),
      );
      if (status.apiMajor !== SUPPORTED_SYNCH_API_MAJOR) {
        this.serverCompatibilityStatus = {
          state: "incompatible",
          currentVersion: this.deps.getPluginVersion(),
          minVersion: status.minVersion,
          apiMajor: status.apiMajor,
          message: t("plugin.serverIncompatible"),
        };
        this.deps.onPluginUpdateRequired();
        this.deps.notify(this.getPluginUpdateRequiredMessage(), 0);
        this.deps.refreshUi();
        return;
      }

      if (status.status !== "update_required") {
        this.serverCompatibilityStatus = {
          state: "ok",
          currentVersion: this.deps.getPluginVersion(),
          minVersion: status.minVersion,
          apiMajor: status.apiMajor,
        };
        return;
      }

      this.serverCompatibilityStatus = {
        state: "update_required",
        currentVersion: this.deps.getPluginVersion(),
        minVersion: status.minVersion,
        message: t("plugin.latestAvailable"),
      };
      this.deps.onPluginUpdateRequired();
      this.deps.notify(this.getPluginUpdateRequiredMessage(), 0);
      this.deps.refreshUi();
    } catch {
      // Only a confirmed server policy response should block sync startup.
    }
  }

  private async checkCommunityPluginUpdate(): Promise<void> {
    if (getServerDeployment(this.deps.getApiBaseUrl()) !== "official_cloud") {
      this.clearCommunityPluginUpdateStatus();
      return;
    }

    if (this.communityPluginUpdateCheckPromise) {
      await this.communityPluginUpdateCheckPromise;
      return;
    }

    this.communityPluginUpdateStatus = {
      state: "checking",
      currentVersion: this.deps.getPluginVersion(),
    };
    this.communityPluginUpdateCheckPromise = this.pluginUpdateChecker
      .check(this.deps.getPluginVersion())
      .then((status) => {
        this.communityPluginUpdateStatus = status;
      })
      .catch((error) => {
        this.communityPluginUpdateStatus = {
          state: "failed",
          currentVersion: this.deps.getPluginVersion(),
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.communityPluginUpdateCheckedAt = Date.now();
        this.communityPluginUpdateCheckPromise = null;
        this.deps.refreshUi();
      });

    await this.communityPluginUpdateCheckPromise;
  }
}
