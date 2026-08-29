import { setIcon, type Plugin } from "obsidian";

import { t } from "../../i18n";
import { formatSyncStatusLabel } from "../../i18n/sync-status";
import type {
  AppWithSettings,
  SynchStorageDisplayState,
  SynchSyncState,
} from "../contracts";

export interface SynchStatusBarState {
  getSyncState(): SynchSyncState;
  getSyncPercent(): number;
  getStorageDisplayState(): SynchStorageDisplayState;
}

const STATUS_BAR_STATE_CLASSES = [
  "synch-status-not-ready",
  "synch-status-paused",
  "synch-status-pending",
  "synch-status-syncing",
  "synch-status-offline",
  "synch-status-reconnecting",
  "synch-status-up-to-date",
  "synch-status-attention-needed",
  "synch-status-update-required",
  "synch-status-storage-warning",
  "synch-status-storage-needs-more",
];

export function getStatusBarStateClass(state: SynchSyncState): string {
  switch (state) {
    case "not_ready":
      return "synch-status-not-ready";
    case "paused":
      return "synch-status-paused";
    case "pending":
      return "synch-status-pending";
    case "syncing":
      return "synch-status-syncing";
    case "offline":
      return "synch-status-offline";
    case "reconnecting":
      return "synch-status-reconnecting";
    case "up_to_date":
      return "synch-status-up-to-date";
    case "attention_needed":
      return "synch-status-attention-needed";
    case "update_required":
      return "synch-status-update-required";
  }
}

export function getStatusBarIcon(state: SynchSyncState): string {
  switch (state) {
    case "not_ready":
      return "circle";
    case "paused":
      return "pause";
    case "pending":
      return "clock";
    case "syncing":
    case "reconnecting":
      return "loader";
    case "offline":
      return "wifi-off";
    case "up_to_date":
      return "check";
    case "attention_needed":
    case "update_required":
      return "triangle-alert";
  }
}

export function openSynchSettings(plugin: Plugin): void {
  const settings = (plugin.app as AppWithSettings).setting;
  settings?.open();
  settings?.openTabById(plugin.manifest.id);
}

export class SynchStatusBar {
  private statusBar: HTMLElement | null = null;
  private icon: HTMLElement | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly state: SynchStatusBarState,
  ) {}

  initialize(): void {
    this.statusBar = this.plugin.addStatusBarItem();
    this.statusBar.addClass("synch-status-bar");
    this.statusBar.empty();
    this.statusBar.setAttribute("role", "button");
    this.icon = this.statusBar.createSpan({
      cls: "synch-status-bar-icon",
    });
    this.icon.setAttribute("aria-hidden", "true");
    this.plugin.registerDomEvent(this.statusBar, "click", () => {
      openSynchSettings(this.plugin);
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.statusBar) {
      return;
    }

    const state = this.state.getSyncState();
    const syncStatusLabel = formatSyncStatusLabel(state, this.state.getSyncPercent());
    const storageState = this.state.getStorageDisplayState();
    const hasStorageWarning = storageState !== "normal";
    const needsMoreStorage = storageState === "needs_more_storage";

    this.statusBar.addClass("synch-status-bar");
    for (const className of STATUS_BAR_STATE_CLASSES) {
      this.statusBar.removeClass(className);
    }
    this.statusBar.addClass(getStatusBarStateClass(state));
    this.statusBar.toggleClass(
      "synch-status-storage-warning",
      storageState === "near_limit",
    );
    this.statusBar.toggleClass(
      "synch-status-storage-needs-more",
      needsMoreStorage,
    );
    if (this.icon) {
      setIcon(this.icon, hasStorageWarning ? "triangle-alert" : getStatusBarIcon(state));
    }
    this.statusBar.removeAttribute("title");
    this.statusBar.setAttribute(
      "aria-label",
      needsMoreStorage
        ? t("storage.needsMore")
        : hasStorageWarning
          ? t("status.storageAlmostFull")
        : syncStatusLabel,
    );
    this.statusBar.setAttribute("data-synch-sync-state", state);
    this.statusBar.setAttribute("data-synch-sync-percent", String(this.state.getSyncPercent()));
    this.statusBar.setAttribute(
      "data-synch-storage-warning",
      hasStorageWarning ? "true" : "false",
    );
    this.statusBar.setAttribute("data-synch-storage-state", storageState);
  }
}
