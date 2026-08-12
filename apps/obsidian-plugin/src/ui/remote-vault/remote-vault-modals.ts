import { App, Modal, Setting } from "obsidian";

import { formatVaultPasswordValidationError, t } from "../../i18n";
import type {
  BootstrapRemoteVaultInput,
  CreateRemoteVaultInput,
} from "./ports";
import { validateVaultPassword } from "@synch/vault-crypto";
import type { RemoteVaultRecord } from "@synch/sync-client/remote-vault/types";

export async function openCreateRemoteVaultModal(
  app: App,
  initialVaultName: string,
): Promise<CreateRemoteVaultInput | null> {
  const modal = new CreateRemoteVaultModal(app, initialVaultName);
  return await modal.openAndWait();
}

export async function openBootstrapRemoteVaultModal(
  app: App,
  vaults: RemoteVaultRecord[],
  preferredVaultId: string | null,
  onConnect?: (input: BootstrapRemoteVaultInput) => Promise<void>,
): Promise<BootstrapRemoteVaultInput | null> {
  const modal = new BootstrapRemoteVaultModal(app, vaults, preferredVaultId, onConnect);
  return await modal.openAndWait();
}

export async function openConfirmConnectNonEmptyLocalVaultModal(
  app: App,
): Promise<boolean> {
  const modal = new ConfirmConnectNonEmptyLocalVaultModal(app);
  return await modal.openAndWait();
}

class CreateRemoteVaultModal extends Modal {
  private resolver: ((value: CreateRemoteVaultInput | null) => void) | null = null;
  private result: CreateRemoteVaultInput | null = null;
  private vaultName: string;
  private password = "";
  private confirmPassword = "";

  constructor(app: App, initialVaultName: string) {
    super(app);
    this.vaultName = initialVaultName;
  }

  async openAndWait(): Promise<CreateRemoteVaultInput | null> {
    return await new Promise<CreateRemoteVaultInput | null>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    let createButton: { setDisabled(value: boolean): unknown } | null = null;
    const updateCreateButtonState = (): void => {
      const validationError = this.getValidationError();
      createButton?.setDisabled(validationError !== null);
    };
    let passwordErrorEl: { setText(value: string): unknown } | null = null;
    const updatePasswordError = (): void => {
      passwordErrorEl?.setText(this.getPasswordValidationError() ?? "");
    };

    new Setting(contentEl).setName(t("vault.createHeader")).setHeading();
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.createHint"),
    });

    new Setting(contentEl)
      .setName(t("vault.name"))
      .setDesc(t("vault.nameDesc"))
      .addText((text) => {
        text
          .setPlaceholder(t("vault.namePlaceholder"))
          .setValue(this.vaultName)
          .onChange((value) => {
            this.vaultName = value.trim();
            updateCreateButtonState();
          });
      });

    new Setting(contentEl)
      .setName(t("vault.password"))
      .setDesc(t("vault.passwordDescCreate"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder(t("vault.passwordPlaceholder")).onChange((value) => {
          this.password = value;
          updatePasswordError();
          updateCreateButtonState();
        });
      });

    new Setting(contentEl)
      .setName(t("vault.confirmPassword"))
      .setDesc(t("vault.confirmPasswordDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text
          .setPlaceholder(t("vault.passwordConfirmPlaceholder"))
          .onChange((value) => {
            this.confirmPassword = value;
            updatePasswordError();
            updateCreateButtonState();
          });
      });

    passwordErrorEl = contentEl.createEl("p", {
      cls: "synch-modal-error",
    });
    updatePasswordError();

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("cancel")).onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("vault.create")).setCta().onClick(async () => {
          if (this.getValidationError() !== null) {
            updatePasswordError();
            updateCreateButtonState();
            return;
          }

          const confirmed = await new ConfirmCreateRemoteVaultBackupModal(this.app).openAndWait();
          if (!confirmed) {
            return;
          }

          this.result = {
            name: this.vaultName,
            password: this.password,
            confirmPassword: this.confirmPassword,
          };
          this.close();
        });
        createButton = button;
        updateCreateButtonState();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }

  private getValidationError(): string | null {
    if (!this.vaultName.trim()) {
      return t("vault.nameRequired");
    }

    const passwordValidation = validateVaultPassword(this.password);
    if (!passwordValidation.ok) {
      return formatVaultPasswordValidationError(passwordValidation);
    }

    if (this.password !== this.confirmPassword) {
      return t("vault.passwordMismatch");
    }

    return null;
  }

  private getPasswordValidationError(): string | null {
    if (this.password === "" && this.confirmPassword === "") {
      return null;
    }

    const passwordValidation = validateVaultPassword(this.password);
    if (!passwordValidation.ok) {
      return formatVaultPasswordValidationError(passwordValidation);
    }

    if (this.confirmPassword !== "" && this.password !== this.confirmPassword) {
      return t("vault.passwordMismatch");
    }

    return null;
  }
}

class ConfirmCreateRemoteVaultBackupModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private confirmed = false;

  async openAndWait(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName(t("vault.backupHeader")).setHeading();
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.backupRisk"),
    });
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.backupHint"),
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("cancel")).onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("vault.backupConfirm")).setCta().onClick(() => {
          this.confirmed = true;
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.confirmed);
    this.resolver = null;
  }
}

class ConfirmConnectNonEmptyLocalVaultModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private confirmed = false;

  async openAndWait(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName(t("vault.connect")).setHeading();
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.connectNonEmpty"),
    });
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.connectExistingConflict"),
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("cancel")).onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(t("connectAnyway")).setCta().onClick(() => {
          this.confirmed = true;
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.confirmed);
    this.resolver = null;
  }
}

class BootstrapRemoteVaultModal extends Modal {
  private resolver: ((value: BootstrapRemoteVaultInput | null) => void) | null = null;
  private result: BootstrapRemoteVaultInput | null = null;
  private readonly vaults: RemoteVaultRecord[];
  private selectedVaultId: string;
  private password = "";
  private submitting = false;
  private allowSubmittingClose = false;

  constructor(
    app: App,
    vaults: RemoteVaultRecord[],
    preferredVaultId: string | null,
    private readonly onConnect?: (input: BootstrapRemoteVaultInput) => Promise<void>,
  ) {
    super(app);
    this.vaults = vaults;
    this.selectedVaultId =
      preferredVaultId && vaults.some((vault) => vault.id === preferredVaultId)
        ? preferredVaultId
        : vaults[0]?.id ?? "";
  }

  async openAndWait(): Promise<BootstrapRemoteVaultInput | null> {
    return await new Promise<BootstrapRemoteVaultInput | null>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName(t("vault.connect")).setHeading();
    let errorEl: { setText(value: string): unknown } | null = null;
    let cancelButton: { setDisabled(value: boolean): unknown } | null = null;
    let connectButton: {
      setButtonText(value: string): unknown;
      setDisabled(value: boolean): unknown;
    } | null = null;
    const setError = (message: string): void => {
      errorEl?.setText(message);
    };
    const setSubmitting = (value: boolean): void => {
      this.submitting = value;
      cancelButton?.setDisabled(value);
      connectButton?.setDisabled(value);
      connectButton?.setButtonText(value ? t("vault.connecting") : t("vault.connect"));
    };

    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.connectHint"),
    });

    if (this.vaults.length === 0) {
      contentEl.createEl("p", {
        cls: "synch-modal-empty",
        text: t("vault.noVaults"),
      });

      new Setting(contentEl).addButton((button) => {
        button.setButtonText(t("close")).setCta().onClick(() => {
          this.close();
        });
      });
      return;
    }

    const selectedLabel = contentEl.createEl("p", {
      cls: "synch-modal-selected",
      text: t("vault.selected", { label: this.getSelectedVaultLabel() }),
    });
    const vaultList = contentEl.createDiv({
      cls: "synch-vault-list",
    });
    this.renderVaultButtons(vaultList, selectedLabel);

    new Setting(contentEl)
      .setName(t("vault.password"))
      .setDesc(t("vault.passwordDescConnect"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.setPlaceholder(t("vault.passwordPlaceholder")).onChange((value) => {
          this.password = value;
          setError("");
        });
      });

    errorEl = contentEl.createEl("p", {
      cls: "synch-modal-error",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("cancel")).onClick(() => {
          this.close();
        });
        cancelButton = button;
      })
      .addButton((button) => {
        button.setButtonText(t("vault.connect")).setCta().onClick(async () => {
          if (this.submitting) {
            return;
          }

          const input = {
            vaultId: this.selectedVaultId,
            password: this.password,
          };

          setError("");
          setSubmitting(true);
          try {
            await this.onConnect?.(input);
            this.result = input;
            this.allowSubmittingClose = true;
            this.close();
          } catch (error) {
            setError(formatErrorMessage(error));
            setSubmitting(false);
          }
        });
        connectButton = button;
      });
  }

  close(): void {
    if (this.submitting && !this.allowSubmittingClose) {
      return;
    }

    super.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }

  private renderVaultButtons(containerEl: HTMLElement, selectedLabel: HTMLParagraphElement): void {
    containerEl.empty();

    for (const vault of this.vaults) {
      const button = containerEl.createEl("button", {
        cls: "synch-vault-option",
        text: vault.name,
      });
      button.type = "button";

      if (vault.id === this.selectedVaultId) {
        button.addClass("is-selected");
      }

      button.addEventListener("click", () => {
        this.selectedVaultId = vault.id;
        selectedLabel.setText(t("vault.selected", { label: this.getSelectedVaultLabel() }));
        this.renderVaultButtons(containerEl, selectedLabel);
      });

    }
  }

  private getSelectedVaultLabel(): string {
    const selectedVault = this.vaults.find((vault) => vault.id === this.selectedVaultId);
    if (!selectedVault) {
      return t("vault.none");
    }

    return selectedVault.name;
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
