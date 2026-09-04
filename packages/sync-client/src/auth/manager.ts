import {
  isOffline as detectOffline,
  isOfflineLikeError,
  type OfflineDetector,
} from "../http/network-status";
import {
  AuthClient,
  type AuthenticatedUserSession,
  type DeviceAuthorizationPollResult,
  type DeviceAuthorizationStart,
} from "./client";
import type { AuthSessionTokenStore } from "./session-token-store";

export type AuthReadiness =
  | { state: "anonymous" }
  | { state: "verified"; token: string }
  | { state: "pending_network"; token: string }
  | { state: "rejected"; token: string };

// Auth state for UI display. Label formatting lives in the host app layer.
export type AuthStatus =
  | { state: "signed_in"; displayName: string }
  | { state: "pending_network" }
  | { state: "needs_relogin" }
  | { state: "not_signed_in" };

// Auth events that require user notification. Message formatting lives in the
// host app layer.
export type AuthNoticeEvent =
  | { type: "approval_received" }
  | { type: "signed_in" }
  | { type: "device_sign_in_failed"; message: string }
  | { type: "device_sign_in_expired" }
  | { type: "device_sign_in_canceled" }
  | { type: "device_sign_in_starting" }
  | { type: "opening_browser"; code: string }
  | { type: "signed_out" };

export interface AuthManagerDeps {
  sessionTokenStore: AuthSessionTokenStore;
  getApiBaseUrl: () => string;
  refreshUi: () => void;
  authClient: AuthClient;
  notify: (event: AuthNoticeEvent) => void;
  getLocale: () => string;
  /** Optional app callback URI advertised by the host application. */
  deviceLoginReturnUri?: string;
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
    this.authClient = deps.authClient;
  }

  async initialize(): Promise<void> {
    this.authSessionToken = await this.deps.sessionTokenStore.read();
    this.authSessionVerified = false;
    if (!this.authSessionToken) {
      return;
    }

    await this.refreshReadiness();
  }

  getAuthSessionToken(): string {
    return this.authSessionToken;
  }

  getAuthStatus(): AuthStatus {
    if (!this.hasAuthenticatedSession()) {
      if (this.authPendingNetworkVerification) {
        return { state: "pending_network" };
      }

      if (this.authNeedsRelogin) {
        return { state: "needs_relogin" };
      }

      return { state: "not_signed_in" };
    }

    return { state: "signed_in", displayName: this.authDisplayName };
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
          this.notify({ type: "approval_received" });
          const completed = await this.completeDeviceLogin(poll, run);
          if (completed) {
            this.notify({ type: "signed_in" });
          }
          return true;
        }

        if (poll.status === "pending" || poll.status === "slow_down") {
          pollDelayMs = poll.intervalMs;
          continue;
        }

        this.notify({ type: "device_sign_in_failed", message: poll.message });
        return true;
      }

      if (!this.isActiveDeviceLoginRun(run)) {
        return true;
      }

      this.notify({ type: "device_sign_in_expired" });
      return true;
    } catch (error) {
      if (!this.isActiveDeviceLoginRun(run)) {
        return true;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.notify({ type: "device_sign_in_failed", message });
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
    this.notify({ type: "device_sign_in_canceled" });
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

    this.notify({ type: "signed_out" });
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
    await this.deps.sessionTokenStore.write(this.authSessionToken);
    this.deps.refreshUi();
    return true;
  }

  private notify(event: AuthNoticeEvent): void {
    this.deps.notify(event);
  }

  private reopenDeviceLogin(): void {
    if (!this.deviceAuthorization) {
      this.notify({ type: "device_sign_in_starting" });
      return;
    }

    this.openDeviceLogin(this.deviceAuthorization);
  }

  private isActiveDeviceLoginRun(run: DeviceLoginRun): boolean {
    return this.deviceLoginRun === run && !run.cancelled;
  }

  private openDeviceLogin(authorization: DeviceAuthorizationStart): void {
    this.notify({ type: "opening_browser", code: authorization.userCode });
    this.openExternalUrl(
      withDeviceLoginReturnUri(
        withDeviceLoginLocale(
          authorization.verificationUriComplete,
          this.deps.getLocale(),
        ),
        this.deps.deviceLoginReturnUri,
      ),
    );
  }

  private openExternalUrl(url: string): void {
    if (this.deps.openExternalUrl) {
      this.deps.openExternalUrl(url);
      return;
    }

    const open = (globalThis as { open?: typeof globalThis.open }).open;
    if (typeof open === "function") {
      open(url, "_blank", "noopener,noreferrer");
      return;
    }

    throw new Error("openExternalUrl is required in this environment");
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      return this.deps.delay(ms);
    }

    return new Promise((resolve) => {
      setTimeout(resolve, ms);
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
    await this.deps.sessionTokenStore.clear();
  }
}

function withDeviceLoginLocale(url: string, locale: string): string {
  try {
    const localizedUrl = new URL(url);
    localizedUrl.searchParams.set("lang", locale);
    return localizedUrl.toString();
  } catch {
    return url;
  }
}

function withDeviceLoginReturnUri(url: string, returnUri?: string): string {
  if (!returnUri) {
    return url;
  }

  try {
    const deviceUrl = new URL(url);
    deviceUrl.searchParams.set("return_uri", returnUri);
    return deviceUrl.toString();
  } catch {
    return url;
  }
}
