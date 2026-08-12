import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import { RemoteVaultInputError } from "@synch/sync-client/remote-vault/manager";
import { t } from "../../i18n";
import { formatSynchErrorNotice } from "./error-notices";

describe("formatSynchErrorNotice", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("localizes coded remote vault input errors", () => {
    expect(
      formatSynchErrorNotice(
        new RemoteVaultInputError({ kind: "name_required" }),
        "error.vaultCreation",
      ),
    ).toBe(
      t("error.detail", {
        context: t("error.vaultCreation"),
        message: t("vault.nameRequired"),
      }),
    );

    expect(
      formatSynchErrorNotice(
        new RemoteVaultInputError({ kind: "password_mismatch" }),
        "error.vaultCreation",
      ),
    ).toBe(
      t("error.detail", {
        context: t("error.vaultCreation"),
        message: t("vault.passwordMismatch"),
      }),
    );

    expect(
      formatSynchErrorNotice(
        new RemoteVaultInputError({
          kind: "invalid_password",
          validation: {
            ok: false,
            code: "too_weak",
            message: "Password is too weak.",
          },
        }),
        "error.vaultCreation",
      ),
    ).toBe(
      t("error.detail", {
        context: t("error.vaultCreation"),
        message: t("vault.passwordTooWeak"),
      }),
    );
  });

  it("passes other errors through to the shared formatter", () => {
    const passedThrough = formatSynchErrorNotice(
      new Error("boom"),
      "error.vaultCreation",
    );
    expect(passedThrough).toBe(
      t("error.detail", {
        context: t("error.vaultCreation"),
        message: "boom",
      }),
    );
    expect(passedThrough).toContain("boom");

    expect(
      formatSynchErrorNotice(
        Object.assign(new Error("server cursor details"), {
          code: "cursor_ahead_of_server",
        }),
        "error.vaultCreation",
      ),
    ).toBe(t("sync.cursorMismatch"));
  });
});
