import { ItemView, Notice, Setting, type WorkspaceLeaf } from "obsidian";

import { t } from "../../i18n";
import type {
  SynchEntryVersion,
  SynchEntryVersionCursor,
  SynchEntryVersionsPage,
  SynchVersionPreview,
} from "../contracts";
import { openConfirmModal } from "../modals/confirm-modal";
import { VersionPreviewModal } from "./version-preview-modal";

export const SYNCH_VERSION_HISTORY_VIEW_TYPE = "synch-version-history";
const HISTORY_PAGE_SIZE = 25;

export type VersionHistoryViewState =
  | {
      status: "not_connected" | "no_active_file" | "not_syncable" | "not_synced";
      path?: string;
      message: string;
    }
  | ({
      status: "ready";
    } & SynchEntryVersionsPage);

export interface VersionHistoryViewController {
  listActiveFileVersions(
    before: SynchEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState>;
  previewActiveFileVersion(versionId: string): Promise<SynchVersionPreview>;
  restoreActiveFileVersion(versionId: string): Promise<void>;
}

export class SynchVersionHistoryView extends ItemView {
  private requestId = 0;
  private loading = false;
  private state: VersionHistoryViewState | null = null;
  private versions: SynchEntryVersion[] = [];
  private nextBefore: SynchEntryVersionCursor | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: VersionHistoryViewController,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SYNCH_VERSION_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("version.displayText");
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.versions = [];
    this.nextBefore = null;
    await this.loadPage(null);
  }

  private async loadPage(before: SynchEntryVersionCursor | null): Promise<void> {
    const requestId = ++this.requestId;
    this.loading = true;
    this.render();

    try {
      const state = await this.controller.listActiveFileVersions(
        before,
        HISTORY_PAGE_SIZE,
      );
      if (requestId !== this.requestId) {
        return;
      }

      this.state = state;
      if (state.status === "ready") {
        this.versions = before ? [...this.versions, ...state.versions] : state.versions;
        this.nextBefore = state.nextBefore;
      } else {
        this.versions = [];
        this.nextBefore = null;
      }
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.state = {
        status: "not_connected",
        message: error instanceof Error ? error.message : String(error),
      };
      this.versions = [];
      this.nextBefore = null;
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("synch-history-view");

    new Setting(root).setName(t("version.header")).setHeading();

    if (this.loading && !this.state) {
      root.createEl("p", {
        text: t("version.loadingHistory"),
        cls: "synch-history-muted",
      });
      return;
    }

    if (!this.state) {
      root.createEl("p", {
        text: t("version.openSyncedFile"),
        cls: "synch-history-muted",
      });
      return;
    }

    if (this.state.status !== "ready") {
      if (this.state.path) {
        root.createEl("div", {
          text: this.state.path,
          cls: "synch-history-path",
        });
      }
      root.createEl("p", {
        text: this.state.message,
        cls: "synch-history-muted",
      });
      this.renderRefreshButton(root);
      return;
    }

    root.createEl("div", {
      text: this.state.path,
      cls: "synch-history-path",
    });
    if (this.state.dirty) {
      root.createEl("p", {
        text: t("version.dirty"),
        cls: "synch-history-warning",
      });
    }

    if (this.versions.length === 0) {
      root.createEl("p", {
        text: this.loading ? t("version.loadingHistory") : t("version.empty"),
        cls: "synch-history-muted",
      });
      this.renderRefreshButton(root);
      return;
    }

    const list = root.createDiv({ cls: "synch-history-list" });
    for (const version of this.versions) {
      this.renderVersionRow(list, version, this.state.dirty);
    }

    const actions = root.createDiv({ cls: "synch-history-actions" });
    if (this.nextBefore) {
      const more = actions.createEl("button", {
        text: this.loading ? t("loading") : t("loadMore"),
        cls: "mod-cta",
      });
      more.disabled = this.loading;
      more.addEventListener("click", () => {
        void this.loadPage(this.nextBefore);
      });
    }
    this.renderRefreshButton(actions);
  }

  private renderVersionRow(
    container: HTMLElement,
    version: SynchEntryVersion,
    restoreDisabled: boolean,
  ): void {
    const row = container.createDiv({ cls: "synch-history-row" });
    const main = row.createDiv({ cls: "synch-history-row-main" });
    main.createEl("div", {
      text: formatCapturedAt(version.capturedAt),
      cls: "synch-history-row-title",
    });
    main.createEl("div", {
      text: formatReason(version.reason),
      cls: "synch-history-row-meta",
    });

    const buttons = row.createDiv({ cls: "synch-history-row-actions" });
    const preview = buttons.createEl("button", {
      text: t("preview"),
      cls: "synch-history-preview",
    });
    preview.disabled = this.loading;
    preview.addEventListener("click", () => {
      void this.previewVersion(version);
    });

    const button = buttons.createEl("button", {
      text: restoreDisabled ? t("version.syncFirst") : t("version.restore"),
      cls: "synch-history-restore",
    });
    button.disabled = restoreDisabled || this.loading;
    button.addEventListener("click", () => {
      void this.restoreVersion(version);
    });
  }

  private renderRefreshButton(container: HTMLElement): void {
    const refresh = container.createEl("button", {
      text: this.loading ? t("refreshing") : t("refresh"),
      cls: "synch-history-refresh",
    });
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => {
      void this.refresh();
    });
  }

  private async restoreVersion(version: SynchEntryVersion): Promise<void> {
    const confirmed = await openConfirmModal(
      this.app,
      t("version.restoreConfirm", { capturedAt: formatCapturedAt(version.capturedAt) }),
      t("version.restore"),
    );
    if (!confirmed) {
      return;
    }

    this.loading = true;
    this.render();
    try {
      await this.controller.restoreActiveFileVersion(version.versionId);
      new Notice(t("version.restored"));
      await this.refresh();
    } catch (error) {
      new Notice(
        t("version.restoreFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      this.loading = false;
      this.render();
    }
  }

  private async previewVersion(version: SynchEntryVersion): Promise<void> {
    try {
      const preview = await this.controller.previewActiveFileVersion(version.versionId);
      new VersionPreviewModal(this.app, preview).open();
    } catch (error) {
      new Notice(
        t("version.previewFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function formatCapturedAt(value: number): string {
  return new Date(value).toLocaleString();
}

function formatReason(reason: SynchEntryVersion["reason"]): string {
  if (reason === "before_delete") {
    return t("version.beforeDelete");
  }
  if (reason === "before_restore") {
    return t("version.beforeRestore");
  }
  if (reason === "manual") {
    return t("version.manual");
  }
  return "Auto";
}
