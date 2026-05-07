import { App, Modal, Notice, Setting } from "obsidian";

import { t } from "../../i18n";
import type {
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFile,
  SynchDeletedFilesRestoreResult,
  SynchVersionPreview,
} from "../../plugin/view-models";
import { VersionPreviewModal } from "../../plugin/version-preview-modal";
import { formatDeletedFileTimestamp } from "./format";

const DELETED_FILES_PAGE_SIZE = 25;
const MAX_DELETED_FILES_RESTORE_SELECTION = 100;

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

export class ExcludedFoldersModal extends Modal {
  private readonly selectedFolders: Set<string>;

  constructor(
    app: App,
    private readonly options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
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
    new Setting(contentEl).setName(t('excluded.header')).setHeading();
    contentEl.createEl('p', {
      text: t('excluded.selectHint'),
    });

    if (this.options.availableFolders.length === 0) {
      contentEl.createEl('p', {
        text: t('excluded.availableEmpty'),
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
          setting.setDesc(
            t('excluded.inherited', { parent: inheritedFrom as string }),
          );
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

export class DeletedFilesModal extends Modal {
  private readonly selectedEntryIds = new Set<string>();
  private deletedFiles: SynchDeletedFile[] = [];
  private nextBefore: SynchDeletedFileCursor | null = null;
  private hasMore = false;
  private loading = false;
  private previewingEntryId: string | null = null;
  private error: string | null = null;

  constructor(
    app: App,
    private readonly options: {
      listDeletedFiles: (
        before: SynchDeletedFileCursor | null,
        limit: number,
      ) => Promise<SynchDeletedFilesPage>;
      previewDeletedFile: (
        entryId: string,
        fallbackPath: string,
      ) => Promise<SynchVersionPreview>;
      restoreDeletedFiles: (
        files: SynchDeletedFile[],
      ) => Promise<SynchDeletedFilesRestoreResult>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    void this.loadDeletedFiles();
  }

  private async loadDeletedFiles(): Promise<void> {
    this.deletedFiles = [];
    this.nextBefore = null;
    this.hasMore = false;
    await this.loadDeletedFilesPage(null);
  }

  private async loadMoreDeletedFiles(): Promise<void> {
    if (!this.hasMore || this.loading) {
      return;
    }
    await this.loadDeletedFilesPage(this.nextBefore);
  }

  private async loadDeletedFilesPage(
    before: SynchDeletedFileCursor | null,
  ): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const page = await this.options.listDeletedFiles(
        before,
        DELETED_FILES_PAGE_SIZE,
      );
      this.deletedFiles =
        before === null ? page.files : [...this.deletedFiles, ...page.files];
      this.hasMore = page.hasMore;
      this.nextBefore = page.nextBefore;
      for (const entryId of [...this.selectedEntryIds]) {
        if (!this.deletedFiles.some((file) => file.entryId === entryId)) {
          this.selectedEntryIds.delete(entryId);
        }
      }
    } catch (error) {
      if (before === null) {
        this.deletedFiles = [];
        this.selectedEntryIds.clear();
        this.hasMore = false;
        this.nextBefore = null;
      }
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("synch-deleted-files-modal");
    const headerEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-header",
    });
    const listEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-list",
    });
    const footerEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-footer",
    });
    new Setting(headerEl).setName(t("deleted.header")).setHeading();

    if (this.error) {
      headerEl.createEl("p", {
        cls: "synch-modal-error",
        text: this.error,
      });
    } else {
      const hintRowEl = headerEl.createEl("div", {
        cls: "synch-deleted-files-hint-row",
      });
      hintRowEl.createEl("p", {
        cls: "synch-modal-hint",
        text: t("deleted.hint"),
      });
      if (this.deletedFiles.length > 0) {
        const allLoadedSelected = this.deletedFiles.every((file) =>
          this.selectedEntryIds.has(file.entryId),
        );
        const selectAll = new Setting(hintRowEl).setName("Select all");
        selectAll.settingEl.addClass("synch-deleted-files-select-all");
        selectAll.addToggle((toggle) => {
          toggle
            .setValue(allLoadedSelected)
            .setDisabled(this.loading)
            .onChange((value) => {
              for (const file of this.deletedFiles) {
                if (value) {
                  if (this.selectedEntryIds.has(file.entryId)) {
                    continue;
                  }
                  if (
                    this.selectedEntryIds.size >= MAX_DELETED_FILES_RESTORE_SELECTION
                  ) {
                    this.showRestoreSelectionLimitNotice();
                    break;
                  }
                  this.selectedEntryIds.add(file.entryId);
                } else {
                  this.selectedEntryIds.delete(file.entryId);
                }
              }
              this.render();
            });
        });
      }
    }

    if (this.loading) {
      listEl.createEl("p", {
        cls: "synch-modal-empty",
        text: t("deleted.loading"),
      });
    } else if (!this.error && this.deletedFiles.length === 0) {
      listEl.createEl("p", {
        cls: "synch-modal-empty",
        text: t("deleted.empty"),
      });
    } else {
      for (const file of this.deletedFiles) {
        const previewing = this.previewingEntryId === file.entryId;
        const setting = new Setting(listEl)
          .setName(file.path)
          .setDesc(
            t("deleted.deletedAt", {
              deletedAt: formatDeletedFileTimestamp(file.deletedAt),
            }),
          );
        setting.addButton((button) => {
          button
            .setButtonText(previewing ? t("preview.loading") : t("preview"))
            .setDisabled(this.loading || previewing)
            .onClick(() => {
              void this.previewDeletedFile(file);
            });
        });
        setting.addToggle((toggle) => {
          const selected = this.selectedEntryIds.has(file.entryId);
          toggle
            .setValue(selected)
            .setDisabled(
              this.loading ||
                (!selected &&
                  this.selectedEntryIds.size >=
                    MAX_DELETED_FILES_RESTORE_SELECTION),
            )
            .onChange((value) => {
              if (value) {
                if (
                  this.selectedEntryIds.size >= MAX_DELETED_FILES_RESTORE_SELECTION
                ) {
                  this.showRestoreSelectionLimitNotice();
                  this.render();
                  return;
                }
                this.selectedEntryIds.add(file.entryId);
              } else {
                this.selectedEntryIds.delete(file.entryId);
              }
              this.render();
            });
        });
      }
      if (this.hasMore) {
        const loadMore = new Setting(listEl);
        loadMore.settingEl.addClass("synch-deleted-files-load-more");
        loadMore.addButton((button) =>
          button
            .setButtonText(t("loadMore"))
            .setDisabled(this.loading)
            .onClick(() => {
              void this.loadMoreDeletedFiles();
            }),
        );
      }
    }

    const selectedCount = this.selectedEntryIds.size;
    const actions = new Setting(footerEl).addButton((button) =>
      button.setButtonText(t("refresh")).setDisabled(this.loading).onClick(() => {
        void this.loadDeletedFiles();
      }),
    );
    actions
      .addButton((button) =>
        button
          .setButtonText(
            selectedCount > 0
              ? t("deleted.restoreSelectedCount", { count: selectedCount })
              : t("deleted.restoreSelected"),
          )
          .setCta()
          .setDisabled(this.loading || selectedCount === 0)
          .onClick(() => {
            void this.restoreSelected();
          }),
      )
      .addButton((button) =>
        button.setButtonText(t("close")).onClick(() => {
          this.close();
        }),
      );
  }

  private async restoreSelected(): Promise<void> {
    const selectedFiles = this.deletedFiles.filter((file) =>
      this.selectedEntryIds.has(file.entryId),
    );
    if (selectedFiles.length === 0) {
      return;
    }

    this.loading = true;
    this.render();

    let result: SynchDeletedFilesRestoreResult;
    try {
      result = await this.options.restoreDeletedFiles(selectedFiles);
    } catch (error) {
      new Notice(
        t("deleted.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.loadDeletedFiles();
      return;
    }

    const failedEntryIds = new Set(
      result.failures.map((failure) => failure.entryId),
    );
    for (const file of selectedFiles) {
      if (!failedEntryIds.has(file.entryId)) {
        this.selectedEntryIds.delete(file.entryId);
      }
    }

    const failed = result.failures.length;
    const restored = result.restored;
    const parts = [t("deleted.restoredCount", { count: restored })];
    if (failed > 0) {
      parts.push(t("deleted.failedCount", { count: failed }));
    }
    new Notice(t("deleted.finished", { summary: parts.join(", ") }));
    await this.loadDeletedFiles();
  }

  private showRestoreSelectionLimitNotice(): void {
    new Notice(
      t("deleted.restoreLimit", { count: MAX_DELETED_FILES_RESTORE_SELECTION }),
    );
  }

  private async previewDeletedFile(file: SynchDeletedFile): Promise<void> {
    if (this.previewingEntryId !== null) {
      return;
    }

    this.previewingEntryId = file.entryId;
    this.render();

    try {
      const preview = await this.options.previewDeletedFile(file.entryId, file.path);
      new VersionPreviewModal(this.app, preview).open();
    } catch (error) {
      new Notice(
        t("deleted.previewFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.previewingEntryId = null;
      this.render();
    }
  }
}
