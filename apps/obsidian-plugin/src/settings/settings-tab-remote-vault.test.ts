import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getButtonComponents,
  getCreatedElementTexts,
  getMarkdownRenderCalls,
  getSettingDescriptions,
  getNotices,
  getSettingClasses,
  getSettingNames,
  getToggleComponents,
  resetObsidianMocks,
} from "../test-stubs/obsidian";
import type { SynchVersionPreview } from "../plugin/view-models";
import { createSettingsTab, nextTask } from "./__tests__/settings-tab-helpers";

describe("SynchSettingTab remote vault settings", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  const getLatestButton = (text: string) =>
    [...getButtonComponents()].reverse().find((button) => button.text === text);

  it("shows a remote vault management button after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
    });

    tab.display();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).toContain("Manage remote vaults");
  });

  it("places remote vault management below authentication when no vault is connected", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.display();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts.slice(0, 4)).toEqual([
      "Create vault",
      "Connect vault",
      "Sign out",
      "Manage remote vaults",
    ]);
  });

  it("shows the vault field only after a vault is connected", () => {
    const disconnected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
    });

    disconnected.display();

    expect(getSettingNames()).toContain("Vault management");
    expect(getSettingNames()).not.toContain("Vault");

    resetObsidianMocks();

    const connected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    connected.display();

    expect(getSettingNames()).toContain("Vault management");
    expect(getSettingNames()).toContain("Vault");
    expect(getButtonComponents().map((button) => button.text)).toContain(
      "Disconnect vault",
    );
  });

  it("shows deleted file restore controls only for connected vaults", () => {
    const disconnected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
    });

    disconnected.display();

    expect(getSettingNames()).not.toContain("Deleted files");
    expect(getButtonComponents().map((button) => button.text)).not.toContain(
      "View deleted files",
    );

    resetObsidianMocks();

    const connected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    connected.display();

    expect(getSettingNames()).toContain("Deleted files");
    expect(getButtonComponents().map((button) => button.text)).toContain(
      "View deleted files",
    );
  });

  it("shows the storage-efficient vault hint below deleted files for format v1 vaults", () => {
    const openRemoteVaultManagementPage = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getRemoteVaultSyncFormatVersion: () => 1,
      openRemoteVaultManagementPage,
    });

    tab.display();

    const settingNames = getSettingNames();
    const deletedFilesIndex = settingNames.indexOf("Deleted files");
    const hintIndex = settingNames.indexOf(
      "New vaults can sync faster and use up to 33% less storage",
    );
    expect(deletedFilesIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBe(deletedFilesIndex + 1);
    expect(getSettingDescriptions()).toContain(
      "To use the latest remote vault version, which is faster and more storage-efficient, delete this remote vault from the vault management page, then create it again. Your local Obsidian vault files are not deleted when you remove the remote vault.",
    );

    getButtonComponents()
      .find((button) => button.text === "Manage remote vaults")
      ?.click();

    expect(openRemoteVaultManagementPage).toHaveBeenCalled();
  });

  it("hides the storage-efficient vault hint for latest-version vaults", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getRemoteVaultSyncFormatVersion: () => 2,
    });

    tab.display();

    expect(getSettingNames()).not.toContain(
      "New vaults can sync faster and use up to 33% less storage",
    );
  });

  it("shows an empty deleted files modal", async () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [],
        hasMore: false,
        nextBefore: null,
      })),
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    expect(getCreatedElementTexts()).toContain(
      "No synced deleted files are available to restore.",
    );
    expect(
      getButtonComponents().find((button) => button.text === "Restore selected")
        ?.disabled,
    ).toBe(true);
  });

  it("restores selected deleted files from the modal", async () => {
    const restoreDeletedFiles = vi.fn(async (files) => ({
      restored: files.length,
      failures: [],
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
          {
            entryId: "entry-other",
            path: "Notes/other.md",
            revision: 4,
            deletedAt: 2,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      restoreDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    const modalToggles = getToggleComponents().slice(-2);
    expect(modalToggles[0]?.disabled).toBe(false);
    expect(modalToggles[1]?.disabled).toBe(false);
    expect(getSettingNames()).toContain("Notes/ready.md");
    expect(getSettingNames()).toContain("Notes/other.md");

    await modalToggles[0]?.change(true);
    await getButtonComponents()
      .find((button) => button.text === "Restore selected (1)")
      ?.click();
    await nextTask();

    expect(restoreDeletedFiles).toHaveBeenCalledWith([
      {
        entryId: "entry-ready",
        path: "Notes/ready.md",
        revision: 3,
        deletedAt: 1,
      },
    ]);
  });

  it("toggles all loaded deleted files from the modal", async () => {
    const restoreDeletedFiles = vi.fn(async (files) => ({
      restored: files.length,
      failures: [],
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
          {
            entryId: "entry-other",
            path: "Notes/other.md",
            revision: 4,
            deletedAt: 2,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      restoreDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    expect(getSettingNames()).toContain("Select all");
    await getToggleComponents().slice(-3)[0]?.change(true);

    expect(
      getLatestButton("Restore selected (2)")?.disabled,
    ).toBe(false);

    await getToggleComponents().slice(-3)[0]?.change(false);

    expect(
      getLatestButton("Restore selected")?.disabled,
    ).toBe(true);

    await getToggleComponents().slice(-3)[0]?.change(true);
    await getLatestButton("Restore selected (2)")?.click();
    await nextTask();

    expect(restoreDeletedFiles).toHaveBeenCalledTimes(1);
    expect(restoreDeletedFiles).toHaveBeenCalledWith([
      {
        entryId: "entry-ready",
        path: "Notes/ready.md",
        revision: 3,
        deletedAt: 1,
      },
      {
        entryId: "entry-other",
        path: "Notes/other.md",
        revision: 4,
        deletedAt: 2,
      },
    ]);
  });

  it("limits deleted file restore selection to 100 files", async () => {
    const deletedFiles = Array.from({ length: 101 }, (_, index) => ({
      entryId: `entry-${index}`,
      path: `Notes/${index}.md`,
      revision: 3,
      deletedAt: index,
    }));
    const restoreDeletedFiles = vi.fn(async (files) => ({
      restored: files.length,
      failures: [],
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: deletedFiles,
        hasMore: false,
        nextBefore: null,
      })),
      restoreDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-102)[0]?.change(true);

    expect(getLatestButton("Restore selected (100)")?.disabled).toBe(false);
    expect(getNotices()).toContainEqual({
      message: "Restore up to 100 deleted files at a time.",
      timeout: undefined,
    });

    await getLatestButton("Restore selected (100)")?.click();
    await nextTask();

    expect(restoreDeletedFiles).toHaveBeenCalledTimes(1);
    expect(restoreDeletedFiles.mock.calls[0]?.[0]).toHaveLength(100);
  });

  it("purges selected deleted files from the modal", async () => {
    const purgeDeletedFiles = vi.fn(async (files) => ({
      purged: files.length,
      failures: [],
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
          {
            entryId: "entry-other",
            path: "Notes/other.md",
            revision: 4,
            deletedAt: 2,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      purgeDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-2)[0]?.change(true);
    await getLatestButton("Permanently remove selected (1)")?.click();
    expect(getCreatedElementTexts()).toContain(
      "Permanently remove version history for 1 selected deleted file? These files will disappear from deleted files and cannot be previewed or restored.",
    );
    await getLatestButton("Permanently remove selected")?.click();
    await nextTask();

    expect(purgeDeletedFiles).toHaveBeenCalledWith([
      {
        entryId: "entry-ready",
        path: "Notes/ready.md",
        revision: 3,
        deletedAt: 1,
      },
    ]);
    expect(getNotices()).toContainEqual({
      message: "Deleted file purge finished: 1 removed.",
      timeout: undefined,
    });
  });

  it("does not purge selected deleted files when confirmation is cancelled", async () => {
    const purgeDeletedFiles = vi.fn(async (files) => ({
      purged: files.length,
      failures: [],
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      purgeDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-1)[0]?.change(true);
    await getLatestButton("Permanently remove selected (1)")?.click();
    await getLatestButton("Cancel")?.click();
    await nextTask();

    expect(purgeDeletedFiles).not.toHaveBeenCalled();
  });

  it("loads additional deleted file pages from the modal", async () => {
    const listDeletedFiles = vi
      .fn()
      .mockResolvedValueOnce({
        files: [
          {
            entryId: "entry-first",
            path: "Notes/first.md",
            revision: 3,
            deletedAt: 10,
          },
        ],
        hasMore: true,
        nextBefore: { deletedAt: 10, entryId: "entry-first" },
      })
      .mockResolvedValueOnce({
        files: [
          {
            entryId: "entry-second",
            path: "Notes/second.md",
            revision: 4,
            deletedAt: 9,
          },
        ],
        hasMore: false,
        nextBefore: null,
      });
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    expect(getSettingNames()).toContain("Notes/first.md");
    expect(getSettingClasses()).toContainEqual([
      "synch-deleted-files-load-more",
    ]);
    await getButtonComponents()
      .filter((button) => button.text === "Load more")
      .at(-1)
      ?.click();
    await nextTask();

    expect(listDeletedFiles).toHaveBeenNthCalledWith(1, null, 25);
    expect(listDeletedFiles).toHaveBeenNthCalledWith(2, {
      deletedAt: 10,
      entryId: "entry-first",
    }, 25);
    expect(getSettingNames()).toContain("Notes/first.md");
    expect(getSettingNames()).toContain("Notes/second.md");
  });

  it("previews deleted files from the modal", async () => {
    const previewDeletedFile = vi.fn(async () => ({
      status: "text" as const,
      path: "Notes/ready.md",
      reason: "before_delete" as const,
      capturedAt: 1,
      text: "previous content",
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      previewDeletedFile,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();

    expect(getButtonComponents().some((button) => button.text === "Preview")).toBe(true);
    await getButtonComponents()
      .find((button) => button.text === "Preview")
      ?.click();
    await nextTask();

    expect(previewDeletedFile).toHaveBeenCalledWith(
      "entry-ready",
      "Notes/ready.md",
    );
    expect(getMarkdownRenderCalls()).toEqual([
      expect.objectContaining({
        markdown: "previous content",
        sourcePath: "Notes/ready.md",
      }),
    ]);
  });

  it("shows a loading state while previewing a deleted file", async () => {
    let resolvePreview: (preview: SynchVersionPreview) => void = () => {};
    const previewPromise = new Promise<SynchVersionPreview>((resolve) => {
      resolvePreview = resolve;
    });
    const previewDeletedFile = vi.fn(() => previewPromise);
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.md",
            revision: 3,
            deletedAt: 1,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      previewDeletedFile,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();
    await getButtonComponents()
      .find((button) => button.text === "Preview")
      ?.click();
    await nextTask();

    expect(
      getButtonComponents().find((button) => button.text === "Loading preview...")
        ?.disabled,
    ).toBe(true);

    resolvePreview({
      status: "text",
      path: "Notes/ready.md",
      reason: "before_delete",
      capturedAt: 1,
      text: "previous content",
    });
    await nextTask();

    expect(getMarkdownRenderCalls()).toEqual([
      expect.objectContaining({
        markdown: "previous content",
        sourcePath: "Notes/ready.md",
      }),
    ]);
  });

  it("previews deleted non-markdown text files as raw text", async () => {
    const previewDeletedFile = vi.fn(async () => ({
      status: "text" as const,
      path: "Notes/ready.txt",
      reason: "before_delete" as const,
      capturedAt: 1,
      text: "previous content",
    }));
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      listDeletedFiles: vi.fn(async () => ({
        files: [
          {
            entryId: "entry-ready",
            path: "Notes/ready.txt",
            revision: 3,
            deletedAt: 1,
          },
        ],
        hasMore: false,
        nextBefore: null,
      })),
      previewDeletedFile,
    });

    tab.display();
    await getButtonComponents()
      .find((button) => button.text === "View deleted files")
      ?.click();
    await nextTask();
    await getButtonComponents()
      .find((button) => button.text === "Preview")
      ?.click();
    await nextTask();

    expect(getMarkdownRenderCalls()).toEqual([]);
    expect(getCreatedElementTexts()).toContain("previous content");
  });

  it("does not show vault configuration sync controls after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
    });

    tab.display();

    expect(getSettingNames()).not.toEqual(
      expect.arrayContaining([
        "Vault configuration sync",
        "App settings",
        "Appearance, themes, and snippets",
        "Hotkeys",
        "Core plugin list",
        "Core plugin settings",
        "Community plugin list",
      ]),
    );
  });
});
