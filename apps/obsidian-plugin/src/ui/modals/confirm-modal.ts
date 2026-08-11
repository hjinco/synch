import { App, Modal, Setting } from "obsidian";

import { t } from "../../i18n";

export async function openConfirmModal(
  app: App,
  message: string,
  confirmText: string,
): Promise<boolean> {
  return await new ConfirmModal(app, message, confirmText).openAndWait();
}

class ConfirmModal extends Modal {
  private confirmed = false;
  private resolver: ((confirmed: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmText: string,
  ) {
    super(app);
  }

  openAndWait(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t("cancel")).onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.confirmed);
    this.resolver = null;
  }
}
