import { setIcon, type Plugin } from "obsidian";

import { t } from "../../i18n";
import { isStorageWarningStatus } from "../../adapters/storage-warning";
import {
  getStatusBarStateClass,
  openSynchSettings,
  type SynchStatusBarState,
} from "./status-bar";

const MOBILE_STATUS_INDICATOR_STATE_CLASSES = [
  "synch-status-attention-needed",
  "synch-status-update-required",
  "synch-status-storage-warning",
];

export class SynchMobileStatusIndicator {
  private indicator: HTMLElement | null = null;
  private icon: HTMLElement | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly state: SynchStatusBarState,
    private readonly rootEl: HTMLElement | null = null,
  ) {}

  initialize(): void {
    const rootEl = this.rootEl ?? activeDocument.body;
    this.indicator = rootEl.createEl("button", {
      cls: "synch-mobile-status-indicator",
    });
    this.indicator.setAttribute("type", "button");
    this.indicator.setAttribute("role", "button");
    this.indicator.setAttribute("aria-label", t("status.openSettings"));
    this.icon = this.indicator.createEl("span", {
      cls: "synch-mobile-status-indicator-icon",
    });
    this.icon.setAttribute("aria-hidden", "true");
    this.plugin.registerDomEvent(this.indicator, "click", () => {
      openSynchSettings(this.plugin);
    });
    this.plugin.register(() => {
      this.indicator?.remove();
      this.indicator = null;
      this.icon = null;
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.indicator) {
      return;
    }

    const state = this.state.getSyncState();
    const hasStorageWarning = isStorageWarningStatus(this.state.getStorageStatus());
    const shouldShow =
      hasStorageWarning || state === "attention_needed" || state === "update_required";

    for (const className of MOBILE_STATUS_INDICATOR_STATE_CLASSES) {
      this.indicator.removeClass(className);
    }
    this.indicator.addClass("synch-mobile-status-indicator");
    this.indicator.toggleClass("synch-mobile-status-indicator-hidden", !shouldShow);
    this.indicator.toggleClass("synch-status-storage-warning", hasStorageWarning);
    if (!hasStorageWarning && (state === "attention_needed" || state === "update_required")) {
      this.indicator.addClass(getStatusBarStateClass(state));
    }
    this.indicator.setAttribute(
      "aria-label",
      hasStorageWarning
        ? t("status.storageAlmostFull")
        : state === "update_required"
          ? t("status.pluginUpdateRequired")
        : t("status.attention"),
    );
    this.indicator.setAttribute("data-synch-sync-state", state);
    this.indicator.setAttribute("data-synch-sync-percent", String(this.state.getSyncPercent()));
    this.indicator.setAttribute(
      "data-synch-storage-warning",
      hasStorageWarning ? "true" : "false",
    );
    if (this.icon) {
      setIcon(this.icon, "triangle-alert");
    }
  }
}
