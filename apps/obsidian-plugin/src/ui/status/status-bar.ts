import { setIcon, type Plugin } from "obsidian";

import { t } from "../../i18n";
import { isStorageWarningStatus } from "../../adapters/storage-warning";
import type { SynchStorageStatus, SynchSyncState } from "../contracts";

export interface ObsidianSettingsApi {
  open(): void;
  openTabById(id: string): void;
}

export interface AppWithSettings {
  setting?: ObsidianSettingsApi;
}

export interface SynchStatusBarState {
  getSyncState(): SynchSyncState;
  getSyncPercent(): number;
  getStorageStatus(): SynchStorageStatus | null;
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
      return "loader-circle";
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
    this.statusBar.setAttribute("aria-label", t("status.openSettings"));
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
    const hasStorageWarning = isStorageWarningStatus(this.state.getStorageStatus());

    this.statusBar.addClass("synch-status-bar");
    for (const className of STATUS_BAR_STATE_CLASSES) {
      this.statusBar.removeClass(className);
    }
    this.statusBar.addClass(getStatusBarStateClass(state));
    this.statusBar.toggleClass("synch-status-storage-warning", hasStorageWarning);
    this.statusBar.toggleClass(
      "synch-status-active",
      !hasStorageWarning && (state === "syncing" || state === "reconnecting"),
    );
    if (this.icon) {
      setIcon(this.icon, hasStorageWarning ? "triangle-alert" : getStatusBarIcon(state));
    }
    this.statusBar.removeAttribute("title");
    this.statusBar.setAttribute(
      "aria-label",
      hasStorageWarning
        ? t("status.storageAlmostFull")
        : state === "update_required"
          ? t("status.pluginUpdateRequired")
        : t("status.openSettings"),
    );
    this.statusBar.setAttribute("data-synch-sync-state", state);
    this.statusBar.setAttribute("data-synch-sync-percent", String(this.state.getSyncPercent()));
    this.statusBar.setAttribute(
      "data-synch-storage-warning",
      hasStorageWarning ? "true" : "false",
    );
  }
}
