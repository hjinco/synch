import { Platform, Plugin } from "obsidian";

import { registerSynchCommands } from "./ui/commands";
import { SynchFileSizeBlockedDecorator } from "./ui/file-size/file-size-blocked-decorator";
import { SynchOpenFilePresence } from "./ui/presence/open-file-presence";
import { SynchMobileStatusIndicator } from "./ui/status/mobile-status-indicator";
import { SynchPluginController } from "./app/plugin-controller";
import { SynchStatusBar } from "./ui/status/status-bar";
import type { SynchUiEvent } from "./ui/ui-events";
import {
  SYNCH_VERSION_HISTORY_VIEW_TYPE,
  SynchVersionHistoryView,
} from "./ui/version-history/version-history-view";
import { SynchSettingTab } from "./ui/settings/settings-tab";

const QUIT_IN_FLIGHT_SYNC_GRACE_MS = 3_000;

export default class SynchPlugin extends Plugin {
  private controller: SynchPluginController | null = null;
  private fileSizeBlockedDecorator: SynchFileSizeBlockedDecorator | null = null;
  private openFilePresence: SynchOpenFilePresence | null = null;
  private mobileStatusIndicator: SynchMobileStatusIndicator | null = null;
  private statusBar: SynchStatusBar | null = null;
  private settingsTab: SynchSettingTab | null = null;

  async onload(): Promise<void> {
    const controller = new SynchPluginController({
      plugin: this,
      refreshUi: () => {
        this.refreshUi();
      },
      emitUiEvent: (event) => {
        this.handleUiEvent(event);
      },
    });
    this.controller = controller;

    await controller.initialize();

    if (Platform.isMobile) {
      this.mobileStatusIndicator = new SynchMobileStatusIndicator(this, controller);
      this.mobileStatusIndicator.initialize();
    } else {
      this.statusBar = new SynchStatusBar(this, controller);
      this.statusBar.initialize();
    }
    this.fileSizeBlockedDecorator = new SynchFileSizeBlockedDecorator(this, controller);
    this.fileSizeBlockedDecorator.initialize();
    this.openFilePresence = new SynchOpenFilePresence(this, controller);
    this.openFilePresence.initialize();

    this.registerView(
      SYNCH_VERSION_HISTORY_VIEW_TYPE,
      (leaf) => new SynchVersionHistoryView(leaf, controller),
    );
    this.settingsTab = new SynchSettingTab(this.app, this, controller);
    this.addSettingTab(this.settingsTab);
    registerSynchCommands(this, controller);
    this.registerConnectivityEvents(controller);
    this.registerQuitGrace(controller);

    this.refreshUi();

    this.app.workspace.onLayoutReady(() => {
      controller.registerVaultEvents();
      void controller.ensureAutoSyncState();
      void controller.ensureVersionHistoryPane();
      void this.fileSizeBlockedDecorator?.refresh();
      void this.openFilePresence?.syncSession();
    });
  }

  onunload(): void {
    void this.controller?.stop();
  }

  private registerQuitGrace(controller: SynchPluginController): void {
    if (!Platform.isDesktop) {
      return;
    }

    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        controller.queueQuitInFlightSyncWait(tasks, QUIT_IN_FLIGHT_SYNC_GRACE_MS);
      }),
    );
  }

  private registerConnectivityEvents(controller: SynchPluginController): void {
    const resume = () => {
      controller.queueAutoSyncResume();
    };

    this.registerDomEvent(window, "online", resume);
    this.registerDomEvent(window, "focus", resume);
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "visible") {
        resume();
      }
    });
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        controller.refreshVersionHistoryViews();
      }),
    );
  }

  private refreshUi(): void {
    this.settingsTab?.refresh();
    this.mobileStatusIndicator?.refresh();
    this.statusBar?.refresh();
  }

  private handleUiEvent(event: SynchUiEvent): void {
    this.settingsTab?.handleUiEvent(event);
    this.mobileStatusIndicator?.refresh();
    this.statusBar?.refresh();

    if (event.type === "file-size-blocked-changed") {
      this.fileSizeBlockedDecorator?.queueRefresh();
    }
    if (event.type === "sync-status-changed") {
      void this.openFilePresence?.syncSession();
    }
  }
}
