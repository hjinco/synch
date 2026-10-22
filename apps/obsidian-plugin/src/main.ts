import { Platform, Plugin } from "obsidian";

import { registerSynchCommands } from "./ui/commands";
import { SynchFileSizeBlockedDecorator } from "./ui/file-size/file-size-blocked-decorator";
import { SynchOpenFilePresence } from "./ui/presence/open-file-presence";
import { SynchMobileStatusIndicator } from "./ui/status/mobile-status-indicator";
import { SynchPluginController } from "./app/plugin-controller";
import { openSynchSettings, SynchStatusBar } from "./ui/status/status-bar";
import type { SynchUiEvent } from "./ui/ui-events";
import {
  SYNCH_VERSION_HISTORY_VIEW_TYPE,
  SynchVersionHistoryView,
} from "./ui/version-history/version-history-view";
import {
  SYNCH_CONFLICT_VIEW_TYPE,
  SynchConflictView,
} from "./ui/conflicts/conflict-view";
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

    // View types are app registrations and belong in the synchronous part of
    // `onload`, before the first `await`, so a leaf restored from the saved
    // workspace can resolve its view without waiting on `initialize()`.
    this.registerView(
      SYNCH_CONFLICT_VIEW_TYPE,
      (leaf) => new SynchConflictView(leaf, controller),
    );

    await controller.initialize();

    this.registerObsidianProtocolHandler("synch-device-login", () => {
      // The device authorization manager remains the source of truth and
      // receives the session through its existing polling loop. Opening this
      // URI brings Obsidian back to the foreground, opens Synch settings, and
      // refreshes the UI.
      openSynchSettings(this);
      this.refreshUi();
    });

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
      this.registerConflictViewEvents(controller);
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

  /**
   * Conflicts are discovered by looking at the vault, so the list has to follow
   * vault changes rather than sync events: a conflict copy can appear (or be
   * resolved) while the pane is open.
   *
   * Called from `onLayoutReady` because Obsidian fires `create` for every file
   * while it builds the vault index at startup; listening earlier would rescan
   * the vault once per file.
   */
  private registerConflictViewEvents(controller: SynchPluginController): void {
    const refresh = () => {
      controller.refreshConflictViews();
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
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
