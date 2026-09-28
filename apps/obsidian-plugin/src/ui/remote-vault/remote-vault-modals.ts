import { App, Modal, Setting } from "obsidian";

import { formatVaultPasswordValidationError, t } from "../../i18n";
import { submitOnEnter } from "../keyboard";
import type {
  CreateRemoteVaultInput,
} from "@synch/sync-client/remote";
import { validateVaultPassword } from "@synch/vault-crypto";

export async function openCreateRemoteVaultModal(
  app: App,
  initialVaultName: string,
  organizations: { id: string; name: string }[] = [],
): Promise<CreateRemoteVaultInput | null> {
  const modal = new CreateRemoteVaultModal(app, initialVaultName, organizations);
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
  private organizationId: string | undefined;
  private password = "";
  private confirmPassword = "";
  private submitting = false;

  constructor(app: App, initialVaultName: string, private readonly organizations: { id: string; name: string }[]) {
    super(app);
    this.vaultName = initialVaultName;
    this.organizationId = organizations[0]?.id;
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
      createButton?.setDisabled(this.submitting || validationError !== null);
    };
    let passwordErrorEl: { setText(value: string): unknown } | null = null;
    const updatePasswordError = (): void => {
      passwordErrorEl?.setText(this.getPasswordValidationError() ?? "");
    };
    const submitCreate = async (): Promise<void> => {
      if (this.submitting) {
        return;
      }

      if (this.getValidationError() !== null) {
        updatePasswordError();
        updateCreateButtonState();
        return;
      }

      this.submitting = true;
      updateCreateButtonState();
      const confirmed = await new ConfirmCreateRemoteVaultBackupModal(this.app).openAndWait();
      if (!confirmed) {
        this.submitting = false;
        updateCreateButtonState();
        return;
      }

      this.result = {
        name: this.vaultName,
        ...(this.organizationId ? { organizationId: this.organizationId } : {}),
        password: this.password,
        confirmPassword: this.confirmPassword,
      };
      this.close();
    };

    new Setting(contentEl).setName(t("vault.createHeader")).setHeading();
    contentEl.createEl("p", {
      cls: "synch-modal-hint",
      text: t("vault.createHint"),
    });

    if (this.organizations.length > 0) new Setting(contentEl).setName(t("sharing.organization")).addDropdown(dropdown => {
      for (const org of this.organizations) dropdown.addOption(org.id, org.name);
      dropdown.setValue(this.organizationId ?? "").onChange(value => { this.organizationId = value; });
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
        submitOnEnter(text.inputEl, submitCreate);
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
        submitOnEnter(text.inputEl, submitCreate);
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
        submitOnEnter(text.inputEl, submitCreate);
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
        button.setButtonText(t("vault.create")).setCta().onClick(submitCreate);
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
