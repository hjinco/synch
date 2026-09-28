import { App } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getButtonComponents,
  getCreatedElementTexts,
  getTextComponents,
  resetObsidianMocks,
} from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import {
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
