import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncTokenResponse } from "../remote/client";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import { createTestPlugin } from "../../test-support/test-plugin";
import { SyncController } from "./controller";
import { SyncEngine } from "./engine";

describe("SyncController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules a push on startup when persisted pending mutations remain", async () => {
    const reconcileOnce = vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    const hasPendingMutations = vi
      .spyOn(SyncEngine.prototype, "hasPendingMutations")
      .mockResolvedValue(true);
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const notifyLocalChange = vi
      .spyOn(SyncEngine.prototype, "notifyLocalChange")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.ensureAutoSyncState();

    expect(startAutoSync).toHaveBeenCalledTimes(1);
    expect(notifyLocalChange).toHaveBeenCalledTimes(1);
    expect(reconcileOnce.mock.invocationCallOrder[0]).toBeLessThan(
      hasPendingMutations.mock.invocationCallOrder[0] ?? 0,
    );
    expect(startAutoSync.mock.invocationCallOrder[0]).toBeLessThan(
      notifyLocalChange.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not schedule a startup push when reconcile found no changes and nothing is pending", async () => {
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(true);
    const notifyLocalChange = vi
      .spyOn(SyncEngine.prototype, "notifyLocalChange")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.ensureAutoSyncState();

    expect(notifyLocalChange).toHaveBeenCalledTimes(0);
  });

  it("resumes an already active auto sync loop without forcing reconnect", async () => {
    vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(false);
    const resumeAutoSyncConnection = vi
      .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
      .mockResolvedValue();
    const reconnectAutoSync = vi
      .spyOn(SyncEngine.prototype, "reconnectAutoSync")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.resumeAutoSync();

    expect(resumeAutoSyncConnection).toHaveBeenCalledTimes(1);
    expect(reconnectAutoSync).not.toHaveBeenCalled();
  });

  it("starts auto sync on resume when the loop is not active", async () => {
    vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const resumeAutoSyncConnection = vi
      .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
      .mockResolvedValue();

    const controller = new SyncController(createDeps());

    await controller.resumeAutoSync();

    expect(startAutoSync).toHaveBeenCalledTimes(1);
    expect(resumeAutoSyncConnection).not.toHaveBeenCalled();
  });

  it("stops auto sync and reports paused", () => {
    const stopAutoSync = vi
      .spyOn(SyncEngine.prototype, "stopAutoSync")
      .mockImplementation(() => {});
    const setStorageStatusWatching = vi
      .spyOn(SyncEngine.prototype, "setStorageStatusWatching")
      .mockImplementation(() => {});
    const controller = new SyncController(createDeps());

    controller.stopAutoSyncAndMarkPaused();

    expect(setStorageStatusWatching).toHaveBeenCalledWith(false);
    expect(stopAutoSync).toHaveBeenCalledTimes(1);
    expect(controller.getSyncState()).toBe("paused");
    expect(controller.getSyncStatusLabel()).toBe("Sync: paused 0%");
  });

  it("watches storage status while auto sync starts for a connected vault", async () => {
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(true);
    const setStorageStatusWatching = vi
      .spyOn(SyncEngine.prototype, "setStorageStatusWatching")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.ensureAutoSyncState();

    expect(setStorageStatusWatching).toHaveBeenCalledWith(true);
  });

  it("does not watch storage status without an active authenticated vault", async () => {
    const stopAutoSync = vi
      .spyOn(SyncEngine.prototype, "stopAutoSync")
      .mockImplementation(() => {});
    const setStorageStatusWatching = vi
      .spyOn(SyncEngine.prototype, "setStorageStatusWatching")
      .mockImplementation(() => {});
    const controller = new SyncController(
      createDeps({
        hasActiveRemoteVaultSession: () => false,
        hasAuthenticatedSession: () => false,
      }),
    );

    await controller.ensureAutoSyncState();

    expect(setStorageStatusWatching).toHaveBeenCalledWith(false);
    expect(stopAutoSync).toHaveBeenCalledTimes(1);
    expect(controller.getStorageStatus()).toBeNull();
  });

  it("clears storage watching when local sync state is reset", async () => {
    const stopAutoSync = vi
      .spyOn(SyncEngine.prototype, "stopAutoSync")
      .mockImplementation(() => {});
    vi.spyOn(SyncEngine.prototype, "detachStore").mockReturnValue(null);
    const setStorageStatusWatching = vi
      .spyOn(SyncEngine.prototype, "setStorageStatusWatching")
      .mockImplementation(() => {});
    const controller = new SyncController(createDeps());

    await controller.resetLocalSyncState();

    expect(setStorageStatusWatching).toHaveBeenCalledWith(false);
    expect(stopAutoSync).toHaveBeenCalledTimes(1);
    expect(controller.getStorageStatus()).toBeNull();
  });

  it("shows offline instead of not ready when a stored vault cannot activate offline", async () => {
    const notifyError = vi.fn();
    const controller = new SyncController(
      createDeps({
        hasActiveRemoteVaultSession: () => false,
        hasConnectedRemoteVault: () => true,
        isOffline: () => true,
        notifyError,
      }),
    );

    await controller.ensureAutoSyncState();

    expect(controller.getSyncState()).toBe("offline");
    expect(controller.getSyncStatusLabel()).toBe("Sync: offline 0%");
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("preserves offline while a stored vault is still inactive", async () => {
    const controller = new SyncController(
      createDeps({
        hasActiveRemoteVaultSession: () => false,
        hasConnectedRemoteVault: () => true,
        isOffline: () => false,
      }),
    );
    controller.markOffline();

    await controller.ensureAutoSyncState();

    expect(controller.getSyncState()).toBe("offline");
  });

  it("keeps attention needed when an inactive stored vault had a non-offline failure", async () => {
    const controller = new SyncController(
      createDeps({
        hasActiveRemoteVaultSession: () => false,
        hasConnectedRemoteVault: () => true,
        isOffline: () => false,
      }),
    );
    controller.markOffline();
    controller.markAttentionNeeded();

    await controller.resumeAutoSync();

    expect(controller.getSyncState()).toBe("attention_needed");
  });

  it("returns no file-size blocked files without an active authenticated remote vault session", async () => {
    const listFileSizeBlockedFiles = vi
      .spyOn(SyncEngine.prototype, "listFileSizeBlockedFiles")
      .mockResolvedValue([
        {
          path: "large.md",
          encryptedSizeBytes: 12_400_000,
          maxFileSizeBytes: 10_000_000,
        },
      ]);
    const controller = new SyncController(
      createDeps({
        hasActiveRemoteVaultSession: () => false,
      }),
    );

    await expect(controller.listFileSizeBlockedFiles()).resolves.toEqual([]);
    expect(listFileSizeBlockedFiles).not.toHaveBeenCalled();
  });
});

function createDeps(
  overrides: Partial<ConstructorParameters<typeof SyncController>[0]> = {},
): ConstructorParameters<typeof SyncController>[0] {
  return {
    plugin: createTestPlugin(),
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    getRemoteVaultKey: () => new Uint8Array(32),
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    hasActiveRemoteVaultSession: () => true,
    hasConnectedRemoteVault: () => true,
    hasAuthenticatedSession: () => true,
    notifyError: vi.fn(),
    ...overrides,
  };
}

function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
    syncFormatVersion: 1,
  };
}
