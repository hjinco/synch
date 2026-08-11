import { t } from "../../i18n";
import type { AuthNoticeEvent, AuthStatus } from "@synch/sync-client/auth/manager";

export function formatAuthStatusLabel(status: AuthStatus): string {
  switch (status.state) {
    case "signed_in":
      return status.displayName
        ? t("auth.signedIn", { name: status.displayName })
        : t("auth.signedInDevice");
    case "pending_network":
      return t("network.requiredDesc");
    case "needs_relogin":
      return t("auth.signInAgain");
    case "not_signed_in":
      return t("auth.notSignedIn");
  }
}

export function formatAuthNotice(
  event: AuthNoticeEvent,
  status: AuthStatus,
): string {
  switch (event.type) {
    case "approval_received":
      return t("auth.approvalReceived");
    case "signed_in":
      return formatAuthStatusLabel(status);
    case "device_sign_in_failed":
      return t("auth.deviceSignInFailed", { message: event.message });
    case "device_sign_in_expired":
      return t("auth.deviceSignInExpired");
    case "device_sign_in_canceled":
      return t("auth.deviceSignInCanceled");
    case "device_sign_in_starting":
      return t("auth.deviceSignInStarting");
    case "opening_browser":
      return t("auth.openingBrowser", { code: event.code });
    case "signed_out":
      return t("auth.signedOutDevice");
  }
}
