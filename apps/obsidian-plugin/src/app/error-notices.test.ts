import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import { RemoteVaultInputError } from "../remote-vault/manager";
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
    ).toBe("Vault creation failed: Vault name is required.");

    expect(
      formatSynchErrorNotice(
        new RemoteVaultInputError({ kind: "password_mismatch" }),
        "error.vaultCreation",
      ),
    ).toBe("Vault creation failed: Passwords do not match.");

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
      "Vault creation failed: Password is too easy to guess. Use a longer passphrase.",
    );
  });

  it("passes other errors through to the shared formatter", () => {
    expect(
      formatSynchErrorNotice(new Error("boom"), "error.vaultCreation"),
    ).toBe("Vault creation failed: boom");

    expect(
      formatSynchErrorNotice(
        Object.assign(new Error("server cursor details"), {
          code: "cursor_ahead_of_server",
        }),
        "error.vaultCreation",
      ),
    ).toBe(
      "Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
    );
  });
});
