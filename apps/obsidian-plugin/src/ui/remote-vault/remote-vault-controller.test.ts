import { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/core";
import { resetObsidianMocks, setLanguage } from "../../test-stubs/obsidian";
import type { RemoteVaultPort } from "./ports";
import {
  SynchRemoteVaultController,
  type RemoteVaultSyncPort,
} from "./remote-vault-controller";

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
      remoteVaultManager: {} as RemoteVaultPort,
      syncController: {} as RemoteVaultSyncPort,
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
      "_external",
      "noopener,noreferrer",
    );
  });
});
