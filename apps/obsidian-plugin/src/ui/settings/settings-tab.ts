import { App, Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian";

import type { SynchUiEvent } from "../ui-events";
import type { SynchSettingsController } from "./controller";
import {
  buildSynchSettingDefinitions,
  getSynchSettingControlValue,
  setSynchSettingControlValue,
  type SynchSettingControlKey,
  type SynchSettingDefinitionsHost,
} from "./setting-definitions";
import type {
  StorageRowSettingControls,
  SyncDiagnosticsSettingControls,
  SyncRowSettingControls,
} from "./sections";

export class SynchSettingTab extends PluginSettingTab {
  private syncRowControls: SyncRowSettingControls | null = null;
  private storageRowControls: StorageRowSettingControls | null = null;
  private syncDiagnosticsControls: SyncDiagnosticsSettingControls | null = null;
  private showSelfHostedServerUrl: boolean | null = null;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: SynchSettingsController,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<SynchSettingControlKey>[] {
    // Rows can disappear between renders (e.g. the sync and storage rows
    // after a vault disconnect). Drop the previous render's controls so
    // stale rows stop receiving UI events; rows still present re-register
    // their controls from their render callbacks.
    this.syncRowControls = null;
    this.storageRowControls = null;
    this.syncDiagnosticsControls = null;
    return buildSynchSettingDefinitions(this.createDefinitionsHost());
  }

  getControlValue(key: string): unknown {
    return getSynchSettingControlValue(this.controller, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await setSynchSettingControlValue(this.controller, key, value);
    // Definitions derive from controller state (e.g. the vault-config sync
    // toggle reveals its per-category toggles), so re-evaluate them after
    // every control change.
    this.refresh();
  }

  refresh(): void {
    this.update();
  }

  refreshFileSizeBlockedWarning(): void {
    this.syncRowControls?.refreshFileSizeBlockedWarning();
  }

  /**
   * These events only affect in-place widgets (sync status, diagnostics log).
   * When the corresponding controls are not rendered — settings closed, or
   * the section is absent — the event is dropped: the widgets read fresh
   * state on the next render, and none of these events change the setting
   * definition set, so no {@link refresh} is needed. Broad state changes
   * (auth, vault connection) flow through {@link refresh} instead.
   */
  handleUiEvent(event: SynchUiEvent): void {
    switch (event.type) {
      case "sync-status-changed":
        this.syncRowControls?.refreshSyncStatus();
        return;
      case "storage-status-changed":
        this.storageRowControls?.refreshStorageStatus();
        return;
      case "file-size-blocked-changed":
        this.refreshFileSizeBlockedWarning();
        return;
      case "sync-log-changed":
        this.syncDiagnosticsControls?.refreshSyncLogs();
        return;
    }
  }

  hide(): void {
    this.syncRowControls = null;
    this.storageRowControls = null;
    this.syncDiagnosticsControls = null;
    super.hide();
  }

  private createDefinitionsHost(): SynchSettingDefinitionsHost {
    return {
      app: this.app,
      controller: this.controller,
      showSelfHostedServerUrl: this.showSelfHostedServerUrl,
      setShowSelfHostedServerUrl: (value) => {
        this.showSelfHostedServerUrl = value;
      },
      requestRefresh: () => this.refresh(),
      setSyncRowControls: (controls) => {
        this.syncRowControls = controls;
      },
      setStorageRowControls: (controls) => {
        this.storageRowControls = controls;
      },
      setSyncDiagnosticsControls: (controls) => {
        this.syncDiagnosticsControls = controls;
      },
    };
  }
}
