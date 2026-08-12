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
} from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import type { SynchVersionPreview } from "../contracts";
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

    tab.open();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).toContain(t("vault.manageRemote"));
  });

  it("places remote vault management below authentication when no vault is connected", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.open();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts.slice(0, 4)).toEqual([
      t("vault.create"),
      t("vault.connect"),
      t("auth.signOut"),
      t("vault.manageRemote"),
    ]);
  });

  it("shows the vault field only after a vault is connected", () => {
    const disconnected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
    });

    disconnected.open();

    expect(getSettingNames()).toContain(t("vault.manage"));
    expect(getSettingNames()).not.toContain(t("vault.setting"));

    resetObsidianMocks();

    const connected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    connected.open();

    expect(getSettingNames()).toContain(t("vault.manage"));
    expect(getSettingNames()).toContain(t("vault.setting"));
    expect(getButtonComponents().map((button) => button.text)).toContain(
      t("vault.disconnect"),
    );
  });

  it("shows deleted file restore controls only for connected vaults", () => {
    const disconnected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
    });

    disconnected.open();

    expect(getSettingNames()).not.toContain(t("deleted.header"));
    expect(getButtonComponents().map((button) => button.text)).not.toContain(
      t("vault.viewDeletedFiles"),
    );

    resetObsidianMocks();

    const connected = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    connected.open();

    expect(getSettingNames()).toContain(t("deleted.header"));
    expect(getButtonComponents().map((button) => button.text)).toContain(
      t("vault.viewDeletedFiles"),
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

    tab.open();

    const settingNames = getSettingNames();
    const deletedFilesIndex = settingNames.indexOf(t("deleted.header"));
    const hintIndex = settingNames.indexOf(t("vault.formatUpgradeTitle"));
    expect(deletedFilesIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBe(deletedFilesIndex + 1);
    expect(getSettingDescriptions()).toContain(t("vault.formatUpgradeDesc"));

    getButtonComponents()
      .find((button) => button.text === t("vault.manageRemote"))
      ?.click();

    expect(openRemoteVaultManagementPage).toHaveBeenCalled();
  });

  it("hides the storage-efficient vault hint for latest-version vaults", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getRemoteVaultSyncFormatVersion: () => 2,
    });

    tab.open();

    expect(getSettingNames()).not.toContain(t("vault.formatUpgradeTitle"));
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    expect(getCreatedElementTexts()).toContain(t("deleted.empty"));
    expect(
      getButtonComponents().find((button) => button.text === t("deleted.restoreSelected"))
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    const modalToggles = getToggleComponents().slice(-2);
    expect(modalToggles[0]?.disabled).toBe(false);
    expect(modalToggles[1]?.disabled).toBe(false);
    expect(getSettingNames()).toContain("Notes/ready.md");
    expect(getSettingNames()).toContain("Notes/other.md");

    await modalToggles[0]?.change(true);
    await getButtonComponents()
      .find((button) => button.text === t("deleted.restoreSelectedCount", { count: 1 }))
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    expect(getSettingNames()).toContain("Select all");
    await getToggleComponents().slice(-3)[0]?.change(true);

    expect(
      getLatestButton(t("deleted.restoreSelectedCount", { count: 2 }))?.disabled,
    ).toBe(false);

    await getToggleComponents().slice(-3)[0]?.change(false);

    expect(
      getLatestButton(t("deleted.restoreSelected"))?.disabled,
    ).toBe(true);

    await getToggleComponents().slice(-3)[0]?.change(true);
    await getLatestButton(t("deleted.restoreSelectedCount", { count: 2 }))?.click();
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-102)[0]?.change(true);

    expect(getLatestButton(t("deleted.restoreSelectedCount", { count: 100 }))?.disabled).toBe(false);
    expect(getNotices()).toContainEqual({
      message: t("deleted.restoreLimit", { count: 100 }),
      timeout: undefined,
    });

    await getLatestButton(t("deleted.restoreSelectedCount", { count: 100 }))?.click();
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-2)[0]?.change(true);
    await getLatestButton(t("deleted.purgeSelectedCount", { count: 1 }))?.click();
    expect(getCreatedElementTexts()).toContain(
      t("deleted.purgeConfirm", { count: 1 }),
    );
    await getLatestButton(t("deleted.purgeSelected"))?.click();
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
      message: t("deleted.purgeFinished", {
        summary: t("deleted.purgedCount", { count: 1 }),
      }),
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    await getToggleComponents().slice(-1)[0]?.change(true);
    await getLatestButton(t("deleted.purgeSelectedCount", { count: 1 }))?.click();
    await getLatestButton(t("cancel"))?.click();
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    expect(getSettingNames()).toContain("Notes/first.md");
    expect(getSettingClasses()).toContainEqual([
      "synch-deleted-files-load-more",
    ]);
    await getButtonComponents()
      .filter((button) => button.text === t("loadMore"))
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();

    expect(getButtonComponents().some((button) => button.text === t("preview"))).toBe(true);
    await getButtonComponents()
      .find((button) => button.text === t("preview"))
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();
    await getButtonComponents()
      .find((button) => button.text === t("preview"))
      ?.click();
    await nextTask();

    expect(
      getButtonComponents().find((button) => button.text === t("preview.loading"))
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

    tab.open();
    await getButtonComponents()
      .find((button) => button.text === t("vault.viewDeletedFiles"))
      ?.click();
    await nextTask();
    await getButtonComponents()
      .find((button) => button.text === t("preview"))
      ?.click();
    await nextTask();

    expect(getMarkdownRenderCalls()).toEqual([]);
    expect(getCreatedElementTexts()).toContain("previous content");
  });

  it("does not show vault configuration sync controls after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
    });

    tab.open();

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
