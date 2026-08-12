import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import { t } from "../../i18n";
import {
  formatRemoteVaultNotice,
  formatRemoteVaultStatusLabel,
} from "./remote-vault-status-label";

describe("formatRemoteVaultStatusLabel", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("maps each remote vault status to its localized label", () => {
    const loaded = formatRemoteVaultStatusLabel({
      state: "loaded",
      label: "Personal",
    });
    expect(loaded).toBe(t("vault.loaded", { label: "Personal" }));
    expect(loaded).toContain("Personal");

    expect(formatRemoteVaultStatusLabel({ state: "stored_inactive" })).toBe(
      t("vault.notActive"),
    );
    expect(formatRemoteVaultStatusLabel({ state: "not_configured" })).toBe(
      t("vault.notConfigured"),
    );
  });
});

describe("formatRemoteVaultNotice", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("maps each remote vault notice event to its localized message", () => {
    const disconnected = formatRemoteVaultNotice({
      type: "disconnected",
      label: "Personal",
    });
    expect(disconnected).toBe(t("vault.disconnected", { label: "Personal" }));
    expect(disconnected).toContain("Personal");

    expect(
      formatRemoteVaultNotice({ type: "created_connected", label: "Personal" }),
    ).toBe(t("vault.createdConnected", { label: "Personal" }));
    expect(
      formatRemoteVaultNotice({ type: "connected", label: "Personal" }),
    ).toBe(t("vault.connected", { label: "Personal" }));
  });
});
