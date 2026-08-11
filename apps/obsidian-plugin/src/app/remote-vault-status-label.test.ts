import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import {
  formatRemoteVaultNotice,
  formatRemoteVaultStatusLabel,
} from "./remote-vault-status-label";

describe("formatRemoteVaultStatusLabel", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("labels each remote vault status", () => {
    expect(
      formatRemoteVaultStatusLabel({ state: "loaded", label: "Personal" }),
    ).toBe("Vault Personal loaded on this device.");
    expect(formatRemoteVaultStatusLabel({ state: "stored_inactive" })).toBe(
      "A vault is stored on this device but not active.",
    );
    expect(formatRemoteVaultStatusLabel({ state: "not_configured" })).toBe(
      "No vault is configured on this device.",
    );
  });
});

describe("formatRemoteVaultNotice", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("formats each remote vault notice event", () => {
    expect(
      formatRemoteVaultNotice({ type: "disconnected", label: "Personal" }),
    ).toBe("Vault Personal disconnected from this device.");
    expect(
      formatRemoteVaultNotice({ type: "created_connected", label: "Personal" }),
    ).toBe("Vault Personal created and connected.");
    expect(
      formatRemoteVaultNotice({ type: "connected", label: "Personal" }),
    ).toBe("Vault Personal connected on this device.");
  });
});
