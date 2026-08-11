import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import { formatAuthNotice, formatAuthStatusLabel } from "./auth-status-label";

describe("formatAuthStatusLabel", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("labels each auth status", () => {
    expect(
      formatAuthStatusLabel({
        state: "signed_in",
        displayName: "user@example.com",
      }),
    ).toBe("Signed in as user@example.com.");
    expect(
      formatAuthStatusLabel({ state: "signed_in", displayName: "" }),
    ).toBe("Signed in on this device.");
    expect(formatAuthStatusLabel({ state: "pending_network" })).toBe(
      "Connect to the internet to check sign-in.",
    );
    expect(formatAuthStatusLabel({ state: "needs_relogin" })).toBe(
      "Sign in again to sync.",
    );
    expect(formatAuthStatusLabel({ state: "not_signed_in" })).toBe(
      "Not signed in.",
    );
  });
});

describe("formatAuthNotice", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("formats each auth notice event", () => {
    const status = {
      state: "signed_in",
      displayName: "user@example.com",
    } as const;

    expect(formatAuthNotice({ type: "approval_received" }, status)).toBe(
      "Approval received. Finishing sign-in...",
    );
    expect(formatAuthNotice({ type: "signed_in" }, status)).toBe(
      "Signed in as user@example.com.",
    );
    expect(
      formatAuthNotice(
        { type: "device_sign_in_failed", message: "boom" },
        status,
      ),
    ).toBe("Device sign-in failed: boom");
    expect(formatAuthNotice({ type: "device_sign_in_expired" }, status)).toBe(
      "Device sign-in expired. Start again from Obsidian.",
    );
    expect(formatAuthNotice({ type: "device_sign_in_canceled" }, status)).toBe(
      "Device sign-in canceled.",
    );
    expect(formatAuthNotice({ type: "device_sign_in_starting" }, status)).toBe(
      "Device sign-in is starting...",
    );
    expect(
      formatAuthNotice({ type: "opening_browser", code: "USER-CODE" }, status),
    ).toBe("Opening browser for device sign-in...\nCode: USER-CODE");
    expect(formatAuthNotice({ type: "signed_out" }, status)).toBe(
      "Signed out on this device.",
    );
  });
});
