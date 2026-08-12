import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import { t } from "../../i18n";
import { formatAuthNotice, formatAuthStatusLabel } from "./auth-status-label";

describe("formatAuthStatusLabel", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("maps each auth status to its localized label", () => {
    const signedIn = formatAuthStatusLabel({
      state: "signed_in",
      displayName: "user@example.com",
    });
    expect(signedIn).toBe(t("auth.signedIn", { name: "user@example.com" }));
    expect(signedIn).toContain("user@example.com");

    expect(
      formatAuthStatusLabel({ state: "signed_in", displayName: "" }),
    ).toBe(t("auth.signedInDevice"));
    expect(formatAuthStatusLabel({ state: "pending_network" })).toBe(
      t("network.requiredDesc"),
    );
    expect(formatAuthStatusLabel({ state: "needs_relogin" })).toBe(
      t("auth.signInAgain"),
    );
    expect(formatAuthStatusLabel({ state: "not_signed_in" })).toBe(
      t("auth.notSignedIn"),
    );
  });
});

describe("formatAuthNotice", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("maps each auth notice event to its localized message", () => {
    const status = {
      state: "signed_in",
      displayName: "user@example.com",
    } as const;

    expect(formatAuthNotice({ type: "approval_received" }, status)).toBe(
      t("auth.approvalReceived"),
    );
    expect(formatAuthNotice({ type: "signed_in" }, status)).toBe(
      formatAuthStatusLabel(status),
    );

    const failed = formatAuthNotice(
      { type: "device_sign_in_failed", message: "boom" },
      status,
    );
    expect(failed).toBe(t("auth.deviceSignInFailed", { message: "boom" }));
    expect(failed).toContain("boom");

    expect(formatAuthNotice({ type: "device_sign_in_expired" }, status)).toBe(
      t("auth.deviceSignInExpired"),
    );
    expect(formatAuthNotice({ type: "device_sign_in_canceled" }, status)).toBe(
      t("auth.deviceSignInCanceled"),
    );
    expect(formatAuthNotice({ type: "device_sign_in_starting" }, status)).toBe(
      t("auth.deviceSignInStarting"),
    );

    const openingBrowser = formatAuthNotice(
      { type: "opening_browser", code: "USER-CODE" },
      status,
    );
    expect(openingBrowser).toBe(t("auth.openingBrowser", { code: "USER-CODE" }));
    expect(openingBrowser).toContain("USER-CODE");

    expect(formatAuthNotice({ type: "signed_out" }, status)).toBe(
      t("auth.signedOutDevice"),
    );
  });
});
