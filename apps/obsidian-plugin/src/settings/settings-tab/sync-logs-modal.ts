import { App, Modal, Notice, Setting } from "obsidian";

import { t } from "../../i18n";
import type { SynchSyncLogs } from "../../plugin/view-models";

export class SyncLogsModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private textArea: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private readonly options: {
      getSyncLogs: () => SynchSyncLogs;
      clearSyncLogs: () => void;
      subscribeSyncLogs: (listener: () => void) => () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    this.unsubscribe = this.options.subscribeSyncLogs(() => {
      this.refresh();
    });
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.textArea = null;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.textArea = null;
    new Setting(contentEl).setName(t("diagnostics.title")).setHeading();

    const snapshot = this.options.getSyncLogs();
    let textArea: HTMLTextAreaElement | null = null;
    if (snapshot.count === 0) {
      contentEl.createEl("p", {
        cls: "synch-diagnostics-empty",
        text: t("diagnostics.empty"),
      });
    } else {
      const logSetting = new Setting(contentEl);
      logSetting.settingEl.addClass("synch-diagnostics-log-setting");
      logSetting.addTextArea((component) => {
        component.setValue(snapshot.text);
        component.inputEl.readOnly = true;
        component.inputEl.rows = 20;
        component.inputEl.classList.add("synch-diagnostics-textarea");
        textArea = component.inputEl;
        this.textArea = component.inputEl;
      });
    }

    const actions = new Setting(contentEl);
    actions.settingEl.addClass("synch-diagnostics-actions");
    if (textArea) {
      const currentTextArea = textArea;
      actions.addButton((button) =>
        button.setButtonText(t("diagnostics.clear")).onClick(() => {
          this.options.clearSyncLogs();
          new Notice(t("diagnostics.cleared"));
        }),
      );
      actions.addButton((button) =>
        button
          .setButtonText(t("diagnostics.copy"))
          .setCta()
          .onClick(async () => {
            await this.copyLogs(
              this.options.getSyncLogs().text,
              currentTextArea,
            );
          }),
      );
    }
    actions.addButton((button) =>
      button.setButtonText(t("close")).onClick(() => {
        this.close();
      }),
    );
  }

  private refresh(): void {
    const snapshot = this.options.getSyncLogs();
    if (snapshot.count > 0 && this.textArea) {
      this.textArea.value = snapshot.text;
      return;
    }
    this.render();
  }

  private async copyLogs(
    text: string,
    textArea: HTMLTextAreaElement,
  ): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice(t("diagnostics.copied"));
        return;
      }
    } catch {
      // Fall through to selecting the text for manual copying.
    }

    textArea.focus();
    textArea.select();
    new Notice(t("diagnostics.copyFailed"));
  }
}
