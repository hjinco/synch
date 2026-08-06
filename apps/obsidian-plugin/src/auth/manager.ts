import { Notice } from "obsidian";

import type { Plugin } from "obsidian";

import {
  isOffline as detectOffline,
  isOfflineLikeError,
  type OfflineDetector,
} from "../http/network-status";
import { getSynchLocale, t } from "../i18n";
import {
  AuthClient,
  type AuthenticatedUserSession,
  type DeviceAuthorizationPollResult,
  type DeviceAuthorizationStart,
} from "./client";
import {
  clearAuthSessionToken,
  readAuthSessionToken,
  writeAuthSessionToken,
} from "./storage";

export type AuthReadiness =
  | { state: "anonymous" }
  | { state: "verified"; token: string }
  | { state: "pending_network"; token: string }
  | { state: "rejected"; token: string };

export interface AuthManagerDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  refreshUi: () => void;
  authClient?: AuthClient;
  notify?: (message: string) => void;
  openExternalUrl?: (url: string) => void;
  delay?: (ms: number) => Promise<void>;
  isOffline?: OfflineDetector;
}

interface DeviceLoginRun {
  cancelled: boolean;
}

export class AuthManager {
  private authSessionToken = "";
  private authSessionVerified = false;
  private authNeedsRelogin = false;
  private authPendingNetworkVerification = false;
  private authDisplayName = "";
  private readonly authClient: AuthClient;
  private deviceLoginRun: DeviceLoginRun | null = null;
  private deviceAuthorization: DeviceAuthorizationStart | null = null;

  constructor(private readonly deps: AuthManagerDeps) {
    this.authClient = deps.authClient ?? new AuthClient();
  }

  async initialize(): Promise<void> {
    this.authSessionToken = await readAuthSessionToken(this.deps.plugin);
    this.authSessionVerified = false;
    if (!this.authSessionToken) {
      return;
    }

    await this.refreshReadiness();
  }

  getAuthSessionToken(): string {
    return this.authSessionToken;
  }

  getAuthStatusLabel(): string {
    if (!this.hasAuthenticatedSession()) {
      if (this.authPendingNetworkVerification) {
        return t("network.requiredDesc");
      }

      if (this.authNeedsRelogin) {
        return t("auth.signInAgain");
      }

      return t("auth.notSignedIn");
    }

    if (this.authDisplayName) {
      return t("auth.signedIn", { name: this.authDisplayName });
    }

    return t("auth.signedInDevice");
  }

  hasAuthenticatedSession(): boolean {
    return this.authSessionVerified;
  }

  getReadiness(): AuthReadiness {
    const token = this.authSessionToken.trim();
    if (!token) {
      return { state: "anonymous" };
    }

    if (this.authSessionVerified) {
      return { state: "verified", token };
    }

    if (this.authPendingNetworkVerification) {
      return { state: "pending_network", token };
    }

    if (this.authNeedsRelogin) {
      return { state: "rejected", token };
    }

    return { state: "pending_network", token };
  }

  async refreshReadiness(): Promise<AuthReadiness> {
    const token = this.authSessionToken.trim();
    if (!token) {
      this.authSessionVerified = false;
      this.authNeedsRelogin = false;
      this.authPendingNetworkVerification = false;
      this.authDisplayName = "";
      return { state: "anonymous" };
    }

    if (this.authSessionVerified) {
      return { state: "verified", token };
    }

    if (detectOffline(this.deps.isOffline)) {
      this.markAuthPendingNetworkVerification();
      return this.getReadiness();
    }

    if (this.authNeedsRelogin) {
      return { state: "rejected", token };
    }

    await this.refreshIdentity();
    return this.getReadiness();
  }

  isDeviceLoginInProgress(): boolean {
    return this.deviceLoginRun !== null && !this.deviceLoginRun.cancelled;
  }

  async beginDeviceLogin(): Promise<boolean> {
    const activeRun = this.deviceLoginRun;
    if (activeRun && !activeRun.cancelled) {
      this.reopenDeviceLogin();
      return false;
    }

    const run: DeviceLoginRun = { cancelled: false };
    this.deviceLoginRun = run;
    this.deviceAuthorization = null;
    this.deps.refreshUi();
    const apiBaseUrl = this.deps.getApiBaseUrl();

    try {
      const authorization = await this.authClient.startDeviceAuthorization(
        apiBaseUrl,
      );
      if (!this.isActiveDeviceLoginRun(run)) {
        return true;
      }

      this.deviceAuthorization = authorization;
      this.deps.refreshUi();

      this.openDeviceLogin(authorization);

      let pollDelayMs = authorization.interval * 1000;
      const deadline = Date.now() + authorization.expiresIn * 1000;

      while (this.isActiveDeviceLoginRun(run) && Date.now() < deadline) {
        await this.wait(pollDelayMs);

        if (!this.isActiveDeviceLoginRun(run)) {
          break;
        }

        const poll = await this.authClient.pollDeviceAuthorization(
          apiBaseUrl,
          authorization.deviceCode,
        );

        if (!this.isActiveDeviceLoginRun(run)) {
          break;
        }

        if (poll.status === "approved") {
          this.notify(t("auth.approvalReceived"));
          const completed = await this.completeDeviceLogin(poll, run);
          if (completed) {
            this.notify(this.getAuthStatusLabel());
          }
          return true;
        }

        if (poll.status === "pending" || poll.status === "slow_down") {
          pollDelayMs = poll.intervalMs;
          continue;
        }

        this.notify(t("auth.deviceSignInFailed", { message: poll.message }));
        return true;
      }

      if (!this.isActiveDeviceLoginRun(run)) {
        return true;
      }

      this.notify(t("auth.deviceSignInExpired"));
      return true;
    } catch (error) {
      if (!this.isActiveDeviceLoginRun(run)) {
        return true;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.notify(t("auth.deviceSignInFailed", { message }));
      return true;
    } finally {
      if (this.deviceLoginRun === run) {
        this.deviceLoginRun = null;
        this.deviceAuthorization = null;
        this.deps.refreshUi();
      }
    }
  }

  cancelDeviceLogin(): void {
    const run = this.deviceLoginRun;
    if (!run || run.cancelled) {
      return;
    }

    run.cancelled = true;
    this.deviceAuthorization = null;
    this.notify(t("auth.deviceSignInCanceled"));
    this.deps.refreshUi();
  }

  async signOutDevice(): Promise<void> {
    if (!this.authSessionToken.trim()) {
      return;
    }

    const apiBaseUrl = this.deps.getApiBaseUrl();

    try {
      if (this.authSessionToken) {
        await this.authClient.signOut(
          apiBaseUrl,
          this.authSessionToken,
        );
      }
    } finally {
      await this.clearLocalAuthSession();
      this.deps.refreshUi();
    }

    this.notify(t("auth.signedOutDevice"));
  }

  private async completeDeviceLogin(
    poll: Extract<DeviceAuthorizationPollResult, { status: "approved" }>,
    run: DeviceLoginRun,
  ): Promise<boolean> {
    if (!this.isActiveDeviceLoginRun(run)) {
      return false;
    }

    const session = await this.authClient.getAuthenticatedUser(
      this.deps.getApiBaseUrl(),
      poll.accessToken,
    );
    if (!session) {
      throw new Error("approved device authorization did not create a session");
    }

    if (!this.isActiveDeviceLoginRun(run)) {
      return false;
    }

    this.authSessionToken = poll.accessToken;
    this.applyVerifiedSession(session);
    await writeAuthSessionToken(this.deps.plugin, this.authSessionToken);
    this.deps.refreshUi();
    return true;
  }

  private notify(message: string): void {
    if (this.deps.notify) {
      this.deps.notify(message);
      return;
    }

    new Notice(message);
  }

  private reopenDeviceLogin(): void {
    if (!this.deviceAuthorization) {
      this.notify(t("auth.deviceSignInStarting"));
      return;
    }

    this.openDeviceLogin(this.deviceAuthorization);
  }

  private isActiveDeviceLoginRun(run: DeviceLoginRun): boolean {
    return this.deviceLoginRun === run && !run.cancelled;
  }

  private openDeviceLogin(authorization: DeviceAuthorizationStart): void {
    this.notify(t("auth.openingBrowser", { code: authorization.userCode }));
    this.openExternalUrl(
      withDeviceLoginLocale(authorization.verificationUriComplete),
    );
  }

  private openExternalUrl(url: string): void {
    if (this.deps.openExternalUrl) {
      this.deps.openExternalUrl(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      return this.deps.delay(ms);
    }

    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  private async refreshIdentity(): Promise<void> {
    try {
      const session = await this.authClient.getAuthenticatedUser(
        this.deps.getApiBaseUrl(),
        this.authSessionToken,
      );
      if (!session) {
        this.markAuthNeedsRelogin();
        return;
      }

      this.applyVerifiedSession(session);
    } catch (error) {
      if (isOfflineLikeError(error, this.deps.isOffline)) {
        this.markAuthPendingNetworkVerification();
        return;
      }

      this.markAuthNeedsRelogin();
    } finally {
      this.deps.refreshUi();
    }
  }

  private applyVerifiedSession(session: AuthenticatedUserSession): void {
    this.authSessionVerified = true;
    this.authNeedsRelogin = false;
    this.authPendingNetworkVerification = false;
    this.authDisplayName = session.email || session.name || "";
  }

  private markAuthPendingNetworkVerification(): void {
    this.authSessionVerified = false;
    this.authNeedsRelogin = false;
    this.authPendingNetworkVerification = true;
    this.authDisplayName = "";
  }

  private markAuthNeedsRelogin(): void {
    this.authSessionVerified = false;
    this.authNeedsRelogin = true;
    this.authPendingNetworkVerification = false;
    this.authDisplayName = "";
  }

  private async clearLocalAuthSession(): Promise<void> {
    this.authSessionToken = "";
    this.authSessionVerified = false;
    this.authNeedsRelogin = false;
    this.authPendingNetworkVerification = false;
    this.authDisplayName = "";
    await clearAuthSessionToken(this.deps.plugin);
  }
}

function withDeviceLoginLocale(url: string): string {
  try {
    const localizedUrl = new URL(url);
    localizedUrl.searchParams.set("lang", getSynchLocale());
    return localizedUrl.toString();
  } catch {
    return url;
  }
}
