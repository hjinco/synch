import { TFile, type Plugin, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/core";
import type { VersionHistorySyncPort } from "./sync-port";
import { SynchVersionHistoryController } from "./version-history-controller";
import { SYNCH_VERSION_HISTORY_VIEW_TYPE } from "./version-history-view";

describe("SynchVersionHistoryController", () => {
  it("creates one right-side history leaf when none exists", async () => {
    const workspace = createWorkspaceMock();
    const controller = createController(workspace);

    await controller.ensurePane();

    expect(workspace.ensureSideLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.ensureSideLeaf).toHaveBeenCalledWith(
      SYNCH_VERSION_HISTORY_VIEW_TYPE,
      "right",
      {
        active: false,
        reveal: false,
        split: false,
      },
    );
    expect(workspace.leaves).toHaveLength(1);
  });

  it("reuses the existing history leaf on repeated ensure calls", async () => {
    const workspace = createWorkspaceMock();
    const controller = createController(workspace);

    await controller.ensurePane();
    await controller.ensurePane();

    expect(workspace.ensureSideLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.leaves).toHaveLength(1);
  });

  it("keeps one existing history leaf and detaches duplicates", async () => {
    const workspace = createWorkspaceMock([
      createLeaf("first"),
      createLeaf("duplicate-a"),
      createLeaf("duplicate-b"),
    ]);
    const controller = createController(workspace);

    await controller.ensurePane();

    expect(workspace.ensureSideLeaf).not.toHaveBeenCalled();
    expect(workspace.leaves.map((leaf) => leaf.id)).toEqual(["first"]);
    expect(workspace.detachedLeafIds).toEqual(["duplicate-a", "duplicate-b"]);
  });

  it("opens the existing history leaf without creating a duplicate", async () => {
    const existingLeaf = createLeaf("existing");
    const workspace = createWorkspaceMock([existingLeaf]);
    const controller = createController(workspace);

    await controller.openPane();

    expect(workspace.ensureSideLeaf).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.leaves).toHaveLength(1);
  });

  it("includes current file text when previewing an active text version", async () => {
    const activeFile = new TFile("Folder/active.md");
    const version = createEntryVersion();
    const workspace = createWorkspaceMock();
    workspace.getActiveFile.mockReturnValue(activeFile);
    const syncController = createSyncControllerMock({
      listEntryVersionsForPath: vi.fn(async () => ({
        path: activeFile.path,
        dirty: false,
        versions: [version],
        hasMore: false,
        nextBefore: null,
      })),
      previewEntryVersionForPath: vi.fn(async () => ({
        status: "text",
        path: activeFile.path,
        reason: "auto",
        capturedAt: 1,
        text: "old body\n",
      })),
    });
    const cachedRead = vi.fn(async () => "current body\n");
    const controller = createController(workspace, {
      syncController,
      vault: { cachedRead },
    });

    await controller.listActiveFileVersions(null, 25);
    const preview = await controller.previewActiveFileVersion(version.versionId);

    expect(syncController.previewEntryVersionForPath).toHaveBeenCalledWith(
      activeFile.path,
      version,
    );
    expect(cachedRead).toHaveBeenCalledWith(activeFile);
    expect(preview).toMatchObject({
      status: "text",
      text: "old body\n",
      currentText: "current body\n",
    });
  });

  it("falls back to plain preview when current file text cannot be read", async () => {
    const activeFile = new TFile("Folder/active.md");
    const version = createEntryVersion();
    const workspace = createWorkspaceMock();
    workspace.getActiveFile.mockReturnValue(activeFile);
    const syncController = createSyncControllerMock({
      listEntryVersionsForPath: vi.fn(async () => ({
        path: activeFile.path,
        dirty: false,
        versions: [version],
        hasMore: false,
        nextBefore: null,
      })),
      previewEntryVersionForPath: vi.fn(async () => ({
        status: "text",
        path: activeFile.path,
        reason: "auto",
        capturedAt: 1,
        text: "old body\n",
      })),
    });
    const controller = createController(workspace, {
      syncController,
      vault: {
        cachedRead: vi.fn(async () => {
          throw new Error("read failed");
        }),
      },
    });

    await controller.listActiveFileVersions(null, 25);
    const preview = await controller.previewActiveFileVersion(version.versionId);

    expect(preview).toEqual({
      status: "text",
      path: activeFile.path,
      reason: "auto",
      capturedAt: 1,
      text: "old body\n",
    });
  });
});

interface MockLeaf extends WorkspaceLeaf {
  id: string;
}

interface WorkspaceMock {
  leaves: MockLeaf[];
  detachedLeafIds: string[];
  ensureSideLeaf: ReturnType<typeof vi.fn>;
  getLeavesOfType: ReturnType<typeof vi.fn>;
  revealLeaf: ReturnType<typeof vi.fn>;
  getActiveFile: ReturnType<typeof vi.fn>;
}

function createController(
  workspace: WorkspaceMock,
  options: {
    syncController?: VersionHistorySyncPort;
    vault?: {
      cachedRead: ReturnType<typeof vi.fn>;
    };
  } = {},
): SynchVersionHistoryController {
  return new SynchVersionHistoryController({
    plugin: {
      app: {
        workspace,
        vault:
          options.vault ??
          ({
            cachedRead: vi.fn(),
          } as unknown),
      },
    } as unknown as Plugin,
    syncController: options.syncController ?? ({} as VersionHistorySyncPort),
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    hasAuthenticatedSession: () => true,
    hasConnectedRemoteVault: () => true,
    refreshUi: vi.fn(),
  });
}

function createWorkspaceMock(initialLeaves: MockLeaf[] = []): WorkspaceMock {
  const workspace: WorkspaceMock = {
    leaves: [...initialLeaves],
    detachedLeafIds: [],
    ensureSideLeaf: vi.fn(async () => {
      const leaf = createLeaf(`created-${workspace.leaves.length + 1}`, workspace);
      workspace.leaves.push(leaf);
      return leaf;
    }),
    getLeavesOfType: vi.fn((viewType: string) => {
      return viewType === SYNCH_VERSION_HISTORY_VIEW_TYPE ? workspace.leaves : [];
    }),
    revealLeaf: vi.fn(async () => {}),
    getActiveFile: vi.fn(() => null),
  };

  for (const leaf of workspace.leaves) {
    attachLeafToWorkspace(leaf, workspace);
  }

  return workspace;
}

function createLeaf(id: string, workspace?: WorkspaceMock): MockLeaf {
  const leaf = {
    id,
    detach: vi.fn(() => {
      if (workspace) {
        workspace.detachedLeafIds.push(id);
        workspace.leaves = workspace.leaves.filter((candidate) => candidate !== leaf);
      }
    }),
  } as unknown as MockLeaf;

  if (workspace) {
    attachLeafToWorkspace(leaf, workspace);
  }

  return leaf;
}

function attachLeafToWorkspace(leaf: MockLeaf, workspace: WorkspaceMock): void {
  leaf.detach = vi.fn(() => {
    workspace.detachedLeafIds.push(leaf.id);
    workspace.leaves = workspace.leaves.filter((candidate) => candidate !== leaf);
  });
}

function createSyncControllerMock(
  overrides: Partial<VersionHistorySyncPort>,
): VersionHistorySyncPort {
  return overrides as VersionHistorySyncPort;
}

function createEntryVersion(): Parameters<
  VersionHistorySyncPort["restoreEntryVersionForPath"]
>[1] {
  return {
    versionId: "version-1",
    sourceRevision: 1,
    op: "upsert",
    blobId: "blob-1",
    encryptedMetadata: new Uint8Array(),
    reason: "auto",
    capturedAt: 1,
  };
}
