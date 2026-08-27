import type { Plugin } from "obsidian";

import type { PresenceSelection } from "@synch/sync-client/sync/core/presence";
import {
  collectOpenMarkdownPresencePaths,
  collectActiveMarkdownPresenceFile,
  type MarkdownPresenceView,
  type PresenceWorkspace,
} from "./open-paths";
import {
  colorForPresenceId,
  peersOnPath,
  presencePeerFromSelection,
  presencePeerLabel,
  selectionColorForPresenceId,
  type PresencePeer,
} from "./presence-codec";
import {
  applyRemotePresence,
  createSynchPresenceEditorExtension,
  getMarkdownEditorView,
  type RemotePresenceCaret,
  type RemotePresenceSelection,
} from "./presence-editor";
import type { PresenceRelay, PresenceUpdatedPush } from "./presence-relay";

const PUBLISH_THROTTLE_MS = 400;
const REANNOUNCE_MS = 15_000;

export interface SynchPresenceHost {
  hasAuthenticatedSession(): boolean;
  hasConnectedRemoteVault(): boolean;
  getPresenceEntryId(path: string): Promise<string | null>;
  getPresencePath(entryId: string): Promise<string | null>;
  watchPresence(entryIds: string[]): void;
  unwatchPresence(): void;
  updatePresence(entryId: string, selection: PresenceSelection): void;
  clearPresence(): void;
  setPresenceRelay(relay: PresenceRelay | null): void;
}

export class SynchOpenFilePresence implements PresenceRelay {
  private readonly roster = new Map<string, PresencePeer>();
  private publishTimer: number | null = null;
  private publishGeneration = 0;
  private watchGeneration = 0;
  private rosterGeneration = 0;
  private readonly watchedEntryIds = new Set<string>();
  private readonly peerRequestTokens = new Map<
    string,
    { token: symbol; entryId: string }
  >();
  private started = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly host: SynchPresenceHost,
  ) {}

  initialize(): void {
    this.host.setPresenceRelay(this);
    this.plugin.registerEditorExtension(
      createSynchPresenceEditorExtension(() => {
        this.handleWorkspaceChange();
      }),
    );
    this.plugin.registerDomEvent(window, "blur", () => {
      this.handleWorkspaceChange();
    });
    this.plugin.registerDomEvent(window, "focus", () => {
      this.handleWorkspaceChange();
    });
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => {
        this.handleWorkspaceChange(true);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-open", () => {
        this.handleWorkspaceChange(true);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        this.handleWorkspaceChange(true);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("editor-change", () => {
        this.render();
        this.schedulePublish();
      }),
    );
    this.plugin.registerInterval(
      window.setInterval(() => {
        void this.publishNow();
      }, REANNOUNCE_MS),
    );
    this.plugin.register(() => {
      this.host.setPresenceRelay(null);
      void this.stop();
    });
    void this.syncSession();
  }

  onUpdated(update: PresenceUpdatedPush): void {
    const token = Symbol();
    this.peerRequestTokens.set(update.presenceId, {
      token,
      entryId: update.entryId,
    });
    void this.storePeer(update, this.rosterGeneration, token);
  }

  onCleared(presenceId: string): void {
    this.peerRequestTokens.delete(presenceId);
    this.roster.delete(presenceId);
    this.render();
  }

  onAvailabilityChanged(enabled: boolean): void {
    if (enabled) {
      void this.publishNow();
      return;
    }

    this.invalidateRoster();
    this.render();
  }

  onReset(): void {
    this.invalidateRoster();
    this.render();
  }

  async syncSession(): Promise<void> {
    if (this.shouldRun()) {
      this.started = true;
      this.handleWorkspaceChange(true);
      return;
    }

    await this.stop();
  }

  private handleWorkspaceChange(updateWatch = false): void {
    this.publishGeneration += 1;
    this.render();
    this.schedulePublish();
    if (updateWatch) {
      void this.syncPresenceWatch();
    }
  }

  private async syncPresenceWatch(): Promise<void> {
    const generation = this.watchGeneration + 1;
    this.watchGeneration = generation;
    const workspace = this.plugin.app.workspace as unknown as PresenceWorkspace;
    const paths = collectOpenMarkdownPresencePaths(workspace);
    const entryIds = uniquePresenceEntryIds(
      (await Promise.all(
        paths.map(async (path) => await this.host.getPresenceEntryId(path)),
      )).filter((entryId): entryId is string => entryId !== null),
    );
    if (
      generation !== this.watchGeneration ||
      !this.started ||
      !this.shouldRun()
    ) {
      return;
    }
    this.applyPresenceWatch(entryIds);
  }

  private shouldRun(): boolean {
    return this.host.hasAuthenticatedSession() && this.host.hasConnectedRemoteVault();
  }

  private schedulePublish(): void {
    if (!this.shouldRun()) {
      return;
    }
    if (this.publishTimer !== null) {
      window.clearTimeout(this.publishTimer);
    }
    this.publishTimer = window.setTimeout(() => {
      this.publishTimer = null;
      void this.publishNow();
    }, PUBLISH_THROTTLE_MS);
  }

  private async publishNow(): Promise<void> {
    if (!this.shouldRun()) {
      return;
    }
    const generation = this.publishGeneration + 1;
    this.publishGeneration = generation;
    const update = await this.buildPresenceUpdate();
    if (generation !== this.publishGeneration) {
      return;
    }
    try {
      if (update) {
        this.applyPresenceWatch([
          update.entryId,
          ...[...this.watchedEntryIds].filter((entryId) => entryId !== update.entryId),
        ]);
        this.host.updatePresence(update.entryId, update.selection);
      } else {
        this.host.clearPresence();
      }
      this.render();
    } catch {
      // Keep sync running even if a presence publish fails.
    }
  }

  private async stop(): Promise<void> {
    this.publishGeneration += 1;
    this.watchGeneration += 1;
    if (this.publishTimer !== null) {
      window.clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    if (this.started) {
      await this.publishEmpty();
      this.host.unwatchPresence();
    }
    this.started = false;
    this.watchedEntryIds.clear();
    this.invalidateRoster();
    this.clearUi();
  }

  private async publishEmpty(): Promise<void> {
    if (!this.canPublishPresence()) {
      return;
    }
    try {
      this.host.clearPresence();
    } catch {
      // Disconnect will still clear this session on the server.
    }
  }

  private async buildPresenceUpdate(): Promise<{
    entryId: string;
    selection: PresenceSelection;
  } | null> {
    if (!this.canPublishPresence()) {
      return null;
    }
    const file = collectActiveMarkdownPresenceFile(
      this.plugin.app.workspace as unknown as PresenceWorkspace,
    );
    if (!file) {
      return null;
    }

    const entryId = await this.host.getPresenceEntryId(file.path);
    if (!entryId) {
      return null;
    }

    return {
      entryId,
      selection: file.selection,
    };
  }

  private canPublishPresence(): boolean {
    return this.host.hasAuthenticatedSession();
  }

  private applyPresenceWatch(entryIds: string[]): void {
    const nextEntryIds = uniquePresenceEntryIds(entryIds);
    const nextWatchedEntryIds = new Set(nextEntryIds);
    let changed = nextWatchedEntryIds.size !== this.watchedEntryIds.size;
    if (!changed) {
      for (const entryId of this.watchedEntryIds) {
        if (!nextWatchedEntryIds.has(entryId)) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      this.watchedEntryIds.clear();
      for (const entryId of nextEntryIds) {
        this.watchedEntryIds.add(entryId);
      }
      for (const [presenceId, peer] of this.roster) {
        if (!nextWatchedEntryIds.has(peer.entryId)) {
          this.roster.delete(presenceId);
        }
      }
      for (const [presenceId, request] of this.peerRequestTokens) {
        if (!nextWatchedEntryIds.has(request.entryId)) {
          this.peerRequestTokens.delete(presenceId);
        }
      }
      this.render();
    }
    this.host.watchPresence(nextEntryIds);
  }

  private invalidateRoster(): void {
    this.rosterGeneration += 1;
    this.peerRequestTokens.clear();
    this.roster.clear();
  }

  private async storePeer(
    update: PresenceUpdatedPush,
    rosterGeneration: number,
    token: symbol,
  ): Promise<void> {
    const path = await this.host.getPresencePath(update.entryId);
    if (!path) {
      this.peerRequestTokens.delete(update.presenceId);
      return;
    }
    if (
      rosterGeneration !== this.rosterGeneration ||
      this.peerRequestTokens.get(update.presenceId)?.token !== token ||
      !this.started ||
      !this.shouldRun() ||
      !this.watchedEntryIds.has(update.entryId)
    ) {
      return;
    }

    this.peerRequestTokens.delete(update.presenceId);
    this.roster.set(
      update.presenceId,
      presencePeerFromSelection(
        {
          presenceId: update.presenceId,
          entryId: update.entryId,
          userId: update.userId,
          displayName: update.displayName,
        },
        update.selection,
        path,
      ),
    );
    this.render();
  }

  private render(): void {
    if (!this.shouldRun()) {
      this.clearUi();
      return;
    }

    this.syncPresenceDecorations();
  }

  private syncPresenceDecorations(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as MarkdownPresenceView;
      const path = view.file?.path;
      const editorView = getMarkdownEditorView(view);
      if (!path || !editorView) {
        continue;
      }
      const carets: RemotePresenceCaret[] = [];
      const selections: RemotePresenceSelection[] = [];
      const peers = peersOnPath(this.roster.values(), path);
      for (const peer of peers) {
        const position = peer.selection.head;
          const color = colorForPresenceId(peer.presenceId);
          carets.push({
            presenceId: peer.presenceId,
            label: presencePeerLabel(peer),
          color,
          line: position.line,
          ch: position.ch,
        });
        selections.push({
          presenceId: peer.presenceId,
          color: selectionColorForPresenceId(peer.presenceId),
          selection: peer.selection,
        });
      }
      applyRemotePresence(editorView, carets, selections);
    }
  }

  private clearUi(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as MarkdownPresenceView;
      const editorView = getMarkdownEditorView(view);
      if (editorView) {
        applyRemotePresence(editorView, [], []);
      }
    }
  }
}

function uniquePresenceEntryIds(entryIds: Array<string | null>): string[] {
  return [
    ...new Set(
      entryIds
        .filter((entryId): entryId is string => entryId !== null)
        .map((entryId) => entryId.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
}
