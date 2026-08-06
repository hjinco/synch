import { TFile, type Plugin, type WorkspaceLeaf } from "obsidian";

import type {
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFile,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFilesRestoreResult,
  SynchEntryVersion,
  SynchEntryVersionCursor,
  SynchEntryVersionsPage,
  SynchVersionPreview,
} from "./view-models";
import {
  SYNCH_VERSION_HISTORY_VIEW_TYPE,
  SynchVersionHistoryView,
  type VersionHistoryViewController,
  type VersionHistoryViewState,
} from "./version-history-view";
import { shouldSyncPath, type SyncFileRules } from "../sync/core/file-rules";
import type { EntryVersion } from "../sync/remote/realtime-client";
import type { SyncController } from "../sync/runtime/controller";
import type { SyncDeletedEntry } from "../sync/runtime/version-history-service";

export interface SynchVersionHistoryControllerDeps {
  plugin: Plugin;
  syncController: SyncController;
  getSyncFileRules: () => SyncFileRules;
  hasAuthenticatedSession: () => boolean;
  hasConnectedRemoteVault: () => boolean;
  refreshUi: () => void;
}

export class SynchVersionHistoryController
  implements VersionHistoryViewController
{
  private readonly activeFileVersionsById = new Map<string, EntryVersion>();

  constructor(private readonly deps: SynchVersionHistoryControllerDeps) {}

  async ensurePane(): Promise<void> {
    await this.getOrCreatePaneLeaf({ active: false, reveal: false });
  }

  async openPane(): Promise<void> {
    const leaf = await this.getOrCreatePaneLeaf({ active: true, reveal: true });
    await this.deps.plugin.app.workspace.revealLeaf(leaf);
  }

  private async getOrCreatePaneLeaf(options: {
    active: boolean;
    reveal: boolean;
  }): Promise<WorkspaceLeaf> {
    const leaves = this.deps.plugin.app.workspace.getLeavesOfType(
      SYNCH_VERSION_HISTORY_VIEW_TYPE,
    );
    const existingLeaf = leaves[0];
    if (existingLeaf) {
      for (const leaf of leaves.slice(1)) {
        leaf.detach();
      }
      return existingLeaf;
    }

    return await this.deps.plugin.app.workspace.ensureSideLeaf(
      SYNCH_VERSION_HISTORY_VIEW_TYPE,
      "right",
      {
        active: options.active,
        reveal: options.reveal,
        split: false,
      },
    );
  }

  async listActiveFileVersions(
    before: SynchEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      return {
        status: "not_connected",
        message: "Connect and sign in before viewing version history.",
      };
    }

    const file = this.deps.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      return {
        status: "no_active_file",
        message: "Open a synced file to view its history.",
      };
    }

    if (
      !shouldSyncPath(
        file.path,
        this.deps.getSyncFileRules(),
        this.deps.plugin.app.vault.configDir,
      )
    ) {
      return {
        status: "not_syncable",
        path: file.path,
        message: "This file is excluded from Synch.",
      };
    }

    const page = await this.deps.syncController.listEntryVersionsForPath(
      file.path,
      before,
      limit,
    );
    if (!page) {
      return {
        status: "not_synced",
        path: file.path,
        message: "This file has not synced yet.",
      };
    }

    if (!before) {
      this.activeFileVersionsById.clear();
    }
    for (const version of page.versions) {
      this.activeFileVersionsById.set(version.versionId, version);
    }

    return {
      status: "ready",
      ...toSynchEntryVersionsPage(page),
    };
  }

  async restoreActiveFileVersion(versionId: string): Promise<void> {
    const file = this.deps.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      throw new Error("Open a synced file before restoring version history.");
    }
    const version = this.activeFileVersionsById.get(versionId);
    if (!version) {
      throw new Error("Refresh version history before restoring this version.");
    }
    await this.deps.syncController.restoreEntryVersionForPath(file.path, version);
    this.deps.refreshUi();
  }

  async previewActiveFileVersion(versionId: string): Promise<SynchVersionPreview> {
    const file = this.deps.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      throw new Error("Open a synced file before previewing version history.");
    }
    const version = this.activeFileVersionsById.get(versionId);
    if (!version) {
      throw new Error("Refresh version history before previewing this version.");
    }
    const preview = await this.deps.syncController.previewEntryVersionForPath(
      file.path,
      version,
    );
    if (preview.status !== "text") {
      return preview;
    }

    let currentText: string;
    try {
      currentText = await this.deps.plugin.app.vault.cachedRead(file);
    } catch {
      return preview;
    }

    return {
      ...preview,
      currentText,
    };
  }

  async listDeletedFiles(
    before: SynchDeletedFileCursor | null,
    limit: number,
  ): Promise<SynchDeletedFilesPage> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before viewing deleted files.");
    }

    const page = await this.deps.syncController.listDeletedEntries(before, limit);
    return {
      files: page.entries.map(toSynchDeletedFile),
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
    };
  }

  async restoreDeletedFiles(
    files: SynchDeletedFile[],
  ): Promise<SynchDeletedFilesRestoreResult> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before restoring deleted files.");
    }

    const result = await this.deps.syncController.restoreDeletedEntries(
      files.map((file) => ({
        entryId: file.entryId,
        revision: file.revision,
      })),
    );
    this.deps.refreshUi();
    return result;
  }

  async purgeDeletedFiles(
    files: SynchDeletedFile[],
  ): Promise<SynchDeletedFilesPurgeResult> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before purging deleted files.");
    }

    const result = await this.deps.syncController.purgeDeletedEntries(
      files.map((file) => ({
        entryId: file.entryId,
        revision: file.revision,
      })),
    );
    this.deps.refreshUi();
    return result;
  }

  async previewDeletedFile(
    entryId: string,
    fallbackPath: string,
  ): Promise<SynchVersionPreview> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before previewing deleted files.");
    }

    return await this.deps.syncController.previewDeletedEntry(entryId, fallbackPath);
  }

  refreshViews(): void {
    for (const leaf of this.deps.plugin.app.workspace.getLeavesOfType(
      SYNCH_VERSION_HISTORY_VIEW_TYPE,
    )) {
      const view = leaf.view;
      if (view instanceof SynchVersionHistoryView) {
        void view.refresh();
      }
    }
  }
}

function toSynchEntryVersionsPage(page: {
  path: string;
  dirty: boolean;
  versions: EntryVersion[];
  hasMore: boolean;
  nextBefore: SynchEntryVersionCursor | null;
}): SynchEntryVersionsPage {
  return {
    path: page.path,
    dirty: page.dirty,
    versions: page.versions.map(toSynchEntryVersion),
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
  };
}

function toSynchEntryVersion(version: EntryVersion): SynchEntryVersion {
  return {
    versionId: version.versionId,
    sourceRevision: version.sourceRevision,
    op: version.op,
    hasBlob: version.blobId !== null,
    reason: version.reason,
    capturedAt: version.capturedAt,
  };
}

function toSynchDeletedFile(file: SyncDeletedEntry): SynchDeletedFile {
  return {
    entryId: file.entryId,
    path: file.path,
    revision: file.revision,
    deletedAt: file.deletedAt,
  };
}
