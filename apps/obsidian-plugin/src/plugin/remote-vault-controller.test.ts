import { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteVaultManager } from "../remote-vault/manager";
import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/sync/core/file-rules";
import type { SyncController } from "../sync/runtime/controller";
import { resetObsidianMocks, setLanguage } from "../test-stubs/obsidian";
import { SynchRemoteVaultController } from "./remote-vault-controller";

describe("SynchRemoteVaultController", () => {
  beforeEach(() => {
    resetObsidianMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens remote vault management in the current Synch web locale", () => {
    setLanguage("ko");
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const controller = new SynchRemoteVaultController({
      plugin: new Plugin(),
      remoteVaultManager: {} as RemoteVaultManager,
      syncController: {} as SyncController,
      clearSyncTokenState: vi.fn(),
      getApiBaseUrl: () => "https://api.synch.run",
      getSyncFileRules: () => ({
        ...DEFAULT_SYNC_FILE_RULES,
      }),
      getStoredRemoteVaultId: () => null,
      hasConnectedRemoteVault: () => false,
      initializeSyncStoreForActiveRemoteVault: vi.fn(async () => {}),
      ensureAutoSyncState: vi.fn(async () => {}),
      resetSyncConnection: vi.fn(async () => {}),
      notifyError: vi.fn(),
    });

    controller.openRemoteVaultManagementPage();

    expect(open).toHaveBeenCalledWith(
      "https://api.synch.run/vaults?lang=ko",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
