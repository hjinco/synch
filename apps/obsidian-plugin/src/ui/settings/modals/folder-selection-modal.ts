import { App, Modal, Setting } from "obsidian";

import { t } from "../../../i18n";

export function findCoveringParent(
  folder: string,
  sortedSelected: readonly string[],
): string | null {
  for (const candidate of sortedSelected) {
    if (folder !== candidate && folder.startsWith(`${candidate}/`)) {
      return candidate;
    }
  }
  return null;
}

interface FolderSelectionModalLabels {
  header: string;
  selectHint: string;
  availableEmpty: string;
  inherited: (parent: string) => string;
}


class FolderSelectionModal extends Modal {
  private readonly selectedFolders: Set<string>;

  constructor(
    app: App,
    private readonly options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
      labels: FolderSelectionModalLabels;
    },
  ) {
    super(app);
    this.selectedFolders = new Set(options.initialSelection);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.options.labels.header).setHeading();
    contentEl.createEl('p', {
      text: this.options.labels.selectHint,
    });

    if (this.options.availableFolders.length === 0) {
      contentEl.createEl('p', {
        text: this.options.labels.availableEmpty,
      });
    } else {
      const sortedSelected = [...this.selectedFolders].sort(
        (left, right) => left.length - right.length,
      );
      for (const folder of this.options.availableFolders) {
        const inheritedFrom = findCoveringParent(folder, sortedSelected);
        const isInherited = inheritedFrom !== null;
        const isOn = isInherited || this.selectedFolders.has(folder);

        const setting = new Setting(contentEl).setName(folder);
        if (isInherited) {
          setting.setDesc(this.options.labels.inherited(inheritedFrom));
        }
        setting.addToggle((toggle) =>
          toggle
            .setValue(isOn)
            .setDisabled(isInherited)
            .onChange((value) => this.handleToggle(folder, value)),
        );
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t('cancel')).onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t('done')).setCta().onClick(() => {
          void this.options.onSubmit(
            [...this.selectedFolders].sort((a, b) => a.localeCompare(b)),
          );
          this.close();
        }),
      );
  }

  private handleToggle(folder: string, value: boolean): void {
    if (value) {
      this.selectedFolders.add(folder);
      const prefix = `${folder}/`;
      for (const candidate of [...this.selectedFolders]) {
        if (candidate !== folder && candidate.startsWith(prefix)) {
          this.selectedFolders.delete(candidate);
        }
      }
    } else {
      this.selectedFolders.delete(folder);
    }
    this.render();
  }
}

export class ExcludedFoldersModal extends FolderSelectionModal {
  constructor(
    app: App,
    options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
    },
  ) {
    super(app, {
      ...options,
      labels: {
        header: t("excluded.header"),
        selectHint: t("excluded.selectHint"),
        availableEmpty: t("excluded.availableEmpty"),
        inherited: (parent) => t("excluded.inherited", { parent }),
      },
    });
  }
}

export class IncludedHiddenFoldersModal extends FolderSelectionModal {
  constructor(
    app: App,
    options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
    },
  ) {
    super(app, {
      ...options,
      labels: {
        header: t("hiddenFolders.header"),
        selectHint: t("hiddenFolders.selectHint"),
        availableEmpty: t("hiddenFolders.availableEmpty"),
        inherited: (parent) => t("hiddenFolders.inherited", { parent }),
      },
    });
  }
}
