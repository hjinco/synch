import { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getButtonComponents,
  getCreatedElements,
  getCreatedElementTexts,
  getTextComponents,
  resetObsidianMocks,
} from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import {
  openBootstrapRemoteVaultModal,
  openConfirmConnectNonEmptyLocalVaultModal,
  openCreateRemoteVaultModal,
} from "./remote-vault-modals";

describe("create vault modal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("disables create while password confirmation does not match", async () => {
    void openCreateRemoteVaultModal(new App(), "Personal");

    const createButton = getButtonComponents().find((button) => button.text === "Create vault");
    const [, passwordInput, confirmPasswordInput] = getTextComponents();

    expect(createButton?.disabled).toBe(true);

    await passwordInput?.change("correct horse battery staple");
    await confirmPasswordInput?.change("different horse battery staple");

    expect(createButton?.disabled).toBe(true);
  });

  it("disables create while password is too weak", async () => {
    void openCreateRemoteVaultModal(new App(), "Personal");

    const createButton = getButtonComponents().find((button) => button.text === "Create vault");
    const [, passwordInput, confirmPasswordInput] = getTextComponents();

    await passwordInput?.change("vault-password");
    await confirmPasswordInput?.change("vault-password");

    expect(createButton?.disabled).toBe(true);
  });

  it("submits once required fields are valid and passwords match", async () => {
    const modalResult = openCreateRemoteVaultModal(new App(), "Personal");

    const createButton = getButtonComponents().find((button) => button.text === "Create vault");
    const [, passwordInput, confirmPasswordInput] = getTextComponents();

    await passwordInput?.change("correct horse battery staple");
    await confirmPasswordInput?.change("correct horse battery staple");
    void createButton?.click();
    await Promise.resolve();

    expect(getCreatedElementTexts()).toContain(t("vault.backupHint"));
    await getButtonComponents()
      .find((button) => button.text === "I backed up, create vault")
      ?.click();

    await expect(modalResult).resolves.toEqual({
      name: "Personal",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
    });
  });

  it("submits when Enter is pressed in a text field", async () => {
    const modalResult = openCreateRemoteVaultModal(new App(), "Personal");

    const [, passwordInput, confirmPasswordInput] = getTextComponents();

    await passwordInput?.change("correct horse battery staple");
    await confirmPasswordInput?.change("correct horse battery staple");
    await confirmPasswordInput?.pressKey("Enter");

    expect(getCreatedElementTexts()).toContain(t("vault.backupHint"));
    await getButtonComponents()
      .find((button) => button.text === "I backed up, create vault")
      ?.click();

    await expect(modalResult).resolves.toEqual({
      name: "Personal",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
    });
  });
});

describe("connect non-empty local vault confirmation modal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("explains the conflict risk without detailed sync behavior", () => {
    void openConfirmConnectNonEmptyLocalVaultModal(new App());

    expect(getCreatedElementTexts()).toContain(t("vault.connectExistingConflict"));
    expect(getButtonComponents().map((button) => button.text)).toEqual([
      t("cancel"),
      t("connectAnyway"),
    ]);
  });

  it("resolves false when canceled and true when confirmed", async () => {
    const canceled = openConfirmConnectNonEmptyLocalVaultModal(new App());
    await getButtonComponents().find((button) => button.text === "Cancel")?.click();
    await expect(canceled).resolves.toBe(false);

    resetObsidianMocks();

    const confirmed = openConfirmConnectNonEmptyLocalVaultModal(new App());
    await getButtonComponents()
      .find((button) => button.text === "Connect anyway")
      ?.click();
    await expect(confirmed).resolves.toBe(true);
  });
});

describe("connect vault modal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("keeps the modal open and shows submit errors inline", async () => {
    const connect = async (): Promise<void> => {
      throw new Error("Unable to unlock vault. Check the password and try again.");
    };
    const modalResult = openBootstrapRemoteVaultModal(
      new App(),
      [
        {
          id: "vault-1",
          organizationId: "org-1",
          name: "Personal",
          activeKeyVersion: 1,
          createdAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      null,
      connect,
    );

    const connectButton = getButtonComponents().find(
      (button) => button.text === "Connect vault",
    );
    const [passwordInput] = getTextComponents();

    await passwordInput?.change("wrong password");
    await connectButton?.click();

    expect(
      getCreatedElements().some(
        (element) =>
          element.classes.includes("synch-modal-error") &&
          element.text === "Unable to unlock vault. Check the password and try again.",
      ),
    ).toBe(true);

    let resolved = false;
    void modalResult.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await getButtonComponents().find((button) => button.text === "Cancel")?.click();
    await expect(modalResult).resolves.toBe(null);
  });

  it("submits when Enter is pressed in the password field", async () => {
    const connect = vi.fn(async () => {});
    const modalResult = openBootstrapRemoteVaultModal(
      new App(),
      [
        {
          id: "vault-1",
          organizationId: "org-1",
          name: "Personal",
          activeKeyVersion: 1,
          createdAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      null,
      connect,
    );

    const [passwordInput] = getTextComponents();
    await passwordInput?.change("vault password");
    await passwordInput?.pressKey("Enter");

    expect(connect).toHaveBeenCalledWith({
      vaultId: "vault-1",
      password: "vault password",
    });
    await expect(modalResult).resolves.toEqual({
      vaultId: "vault-1",
      password: "vault password",
    });
  });

  it("does not resolve as canceled while the connect request is pending", async () => {
    let finishConnect: (() => void) | null = null;
    const connect = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        finishConnect = resolve;
      });
    };
    const modalResult = openBootstrapRemoteVaultModal(
      new App(),
      [
        {
          id: "vault-1",
          organizationId: "org-1",
          name: "Personal",
          activeKeyVersion: 1,
          createdAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      null,
      connect,
    );

    const connectButton = getButtonComponents().find(
      (button) => button.text === "Connect vault",
    );
    const cancelButton = getButtonComponents().find((button) => button.text === "Cancel");
    const [passwordInput] = getTextComponents();

    await passwordInput?.change("vault password");
    const clickPromise = connectButton?.click();
    await Promise.resolve();

    expect(cancelButton?.disabled).toBe(true);
    await cancelButton?.click();

    let resolved = false;
    void modalResult.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    finishConnect?.();
    await clickPromise;
    await expect(modalResult).resolves.toEqual({
      vaultId: "vault-1",
      password: "vault password",
    });
  });
});
