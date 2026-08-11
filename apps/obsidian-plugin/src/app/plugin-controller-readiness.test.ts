import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getNotices,
  resetObsidianMocks,
  setRequestUrlMock,
} from "../test-stubs/obsidian";
import { SyncController } from "../sync/runtime/controller";
import { SynchPluginController } from "./plugin-controller";
import {
  createConnectedPlugin,
  mockOnlineReadinessRequests,
  storedConnection,
} from "./__tests__/readiness-helpers";

describe("SynchPluginController readiness reconciliation", () => {
  beforeEach(() => {
    resetObsidianMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps startup offline as offline instead of treating the stored token as rejected", async () => {
    const plugin = await createConnectedPlugin();
    setRequestUrlMock(
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    const initializeStore = vi
      .spyOn(SyncController.prototype, "initializeStore")
      .mockResolvedValue();
    const startSync = vi
      .spyOn(SyncController.prototype, "ensureAutoSyncState")
      .mockResolvedValue();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();

    expect(controller.getAuthStatusLabel()).toBe(
      "Connect to the internet to check sign-in.",
    );
    expect(controller.getSyncState()).toBe("offline");
    expect(initializeStore).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
  });

  it("restores the stored vault but keeps auto sync paused when sync is disabled", async () => {
    const plugin = await createConnectedPlugin({
      syncEnabled: false,
    });
    mockOnlineReadinessRequests();
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    const initializeStore = vi
      .spyOn(SyncController.prototype, "initializeStore")
      .mockResolvedValue();
    const startSync = vi
      .spyOn(SyncController.prototype, "ensureAutoSyncState")
      .mockResolvedValue();
    const stopAutoSyncAndMarkPaused = vi
      .spyOn(SyncController.prototype, "stopAutoSyncAndMarkPaused")
      .mockImplementation(() => {});
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();

    expect(controller.getAuthStatusLabel()).toBe("Signed in as user@example.com.");
    expect(controller.getRemoteVaultStatusLabel()).toBe(
      "Vault Recovered loaded on this device.",
    );
    expect(initializeStore).toHaveBeenCalledWith("vault-1");
    expect(stopAutoSyncAndMarkPaused).toHaveBeenCalledTimes(1);
    expect(startSync).not.toHaveBeenCalled();
  });

  it("refreshes file-size blocked UI after the stored sync store is initialized", async () => {
    const plugin = await createConnectedPlugin();
    mockOnlineReadinessRequests();
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    vi.spyOn(SyncController.prototype, "initializeStore").mockResolvedValue();
    vi.spyOn(SyncController.prototype, "ensureAutoSyncState").mockResolvedValue();
    const emitUiEvent = vi.fn();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
      emitUiEvent,
    });

    await controller.initialize();
    emitUiEvent.mockClear();
    await controller.ensureAutoSyncState();

    expect(emitUiEvent).toHaveBeenCalledWith({
      type: "file-size-blocked-changed",
    });
  });

  it("revalidates auth, restores the stored vault, and starts sync after reconnect", async () => {
    let offline = true;
    const plugin = await createConnectedPlugin();
    const request = vi.fn(async (input: unknown) => {
      if (offline) {
        throw new Error("Failed to fetch");
      }

      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      if (url.endsWith("/v1/vaults/vault-1/bootstrap")) {
        return {
          status: 200,
          json: {
            vault: {
              id: "vault-1",
              name: "Recovered",
              activeKeyVersion: 1,
              createdAt: "2026-04-22T00:00:00.000Z",
            },
            wrappers: [],
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    const initializeStore = vi
      .spyOn(SyncController.prototype, "initializeStore")
      .mockResolvedValue();
    const startSync = vi
      .spyOn(SyncController.prototype, "ensureAutoSyncState")
      .mockResolvedValue();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();
    expect(controller.getSyncState()).toBe("offline");

    offline = false;
    controller.queueAutoSyncResume();
    await flushPromises();

    expect(controller.getAuthStatusLabel()).toBe("Signed in as user@example.com.");
    expect(controller.getRemoteVaultStatusLabel()).toBe(
      "Vault Recovered loaded on this device.",
    );
    expect(initializeStore).toHaveBeenCalledWith("vault-1");
    expect(startSync).toHaveBeenCalledTimes(1);
  });

  it("resumes an active stored vault without reinitializing the sync store", async () => {
    const plugin = await createConnectedPlugin();
    mockOnlineReadinessRequests();
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    const initializeStore = vi
      .spyOn(SyncController.prototype, "initializeStore")
      .mockResolvedValue();
    vi.spyOn(SyncController.prototype, "hasStore")
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    vi.spyOn(SyncController.prototype, "ensureAutoSyncState").mockResolvedValue();
    const resumeAutoSync = vi
      .spyOn(SyncController.prototype, "resumeAutoSync")
      .mockResolvedValue();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();
    controller.queueAutoSyncResume();
    await flushPromises();

    expect(initializeStore).toHaveBeenCalledTimes(1);
    expect(resumeAutoSync).toHaveBeenCalledTimes(1);
  });

  it("disconnects the remote vault before signing out", async () => {
    const events: string[] = [];
    const plugin = await createConnectedPlugin();
    const request = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      if (url.endsWith("/v1/vaults/vault-1/bootstrap")) {
        return {
          status: 200,
          json: {
            vault: {
              id: "vault-1",
              name: "Recovered",
              activeKeyVersion: 1,
              createdAt: "2026-04-22T00:00:00.000Z",
            },
            wrappers: [],
          },
        };
      }

      if (url.endsWith("/api/auth/sign-out")) {
        events.push("sign-out");
        return {
          status: 200,
          json: {},
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    vi.spyOn(SyncController.prototype, "initializeStore").mockResolvedValue();
    vi.spyOn(SyncController.prototype, "ensureAutoSyncState").mockResolvedValue();
    vi.spyOn(SyncController.prototype, "resetLocalSyncState").mockResolvedValue();
    const detachLocalVaultFromServer = vi
      .spyOn(SyncController.prototype, "detachLocalVaultFromServer")
      .mockImplementation(async () => {
        events.push("detach");
      });
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();
    await controller.signOutDevice();

    expect(detachLocalVaultFromServer).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["detach", "sign-out"]);
    expect(controller.hasConnectedRemoteVault()).toBe(false);
  });

  it("disconnects locally when the stored remote vault is no longer available", async () => {
    const plugin = await createConnectedPlugin();
    setRequestUrlMock(
      vi.fn(async (input: unknown) => {
        const url = String((input as { url?: string }).url ?? "");
        if (url.endsWith("/api/auth/get-session")) {
          return {
            status: 200,
            json: {
              session: { id: "session-1" },
              user: {
                id: "user-1",
                email: "user@example.com",
                name: "User One",
              },
            },
          };
        }

        if (url.endsWith("/v1/vaults/vault-1/bootstrap")) {
          return {
            status: 404,
            json: {
              error: "not_found",
              message: "vault not found",
            },
          };
        }

        throw new Error(`unexpected request ${url}`);
      }),
    );
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    const resetLocalSyncState = vi
      .spyOn(SyncController.prototype, "resetLocalSyncState")
      .mockResolvedValue();
    const startSync = vi
      .spyOn(SyncController.prototype, "ensureAutoSyncState")
      .mockResolvedValue();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();

    expect(controller.hasConnectedRemoteVault()).toBe(false);
    expect(controller.getRemoteVaultStatusLabel()).toBe(
      "No vault is configured on this device.",
    );
    expect(controller.getSyncState()).toBe("not_ready");
    expect(resetLocalSyncState).toHaveBeenCalledTimes(1);
    expect(startSync).not.toHaveBeenCalled();
    expect(getNotices()).toContainEqual({
      message: "Remote vault was removed. Synch disconnected this Obsidian vault.",
      timeout: undefined,
    });
  });

  it("disconnects locally when sync token issuance can no longer access the active vault", async () => {
    const plugin = await createConnectedPlugin();
    const request = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      if (url.endsWith("/v1/vaults/vault-1/bootstrap")) {
        return {
          status: 200,
          json: {
            vault: {
              id: "vault-1",
              name: "Recovered",
              activeKeyVersion: 1,
              createdAt: "2026-04-22T00:00:00.000Z",
            },
            wrappers: [],
          },
        };
      }

      if (url.endsWith("/v1/sync/token")) {
        return {
          status: 403,
          json: {
            error: "forbidden",
            message: "vault access denied",
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    vi.spyOn(SyncController.prototype, "readStoredConnection").mockResolvedValue(
      storedConnection(),
    );
    vi.spyOn(SyncController.prototype, "readLocalVaultId").mockResolvedValue(
      "local-vault-1",
    );
    vi.spyOn(SyncController.prototype, "initializeStore").mockResolvedValue();
    vi.spyOn(SyncController.prototype, "ensureAutoSyncState").mockResolvedValue();
    const resetLocalSyncState = vi
      .spyOn(SyncController.prototype, "resetLocalSyncState")
      .mockResolvedValue();
    const controller = new SynchPluginController({
      plugin,
      refreshUi: vi.fn(),
    });

    await controller.initialize();
    await controller.ensureAutoSyncState();
    await expect(controller.getSyncTokenForActiveRemoteVault()).rejects.toThrow(
      "vault access denied",
    );

    expect(controller.hasConnectedRemoteVault()).toBe(false);
    expect(controller.getSyncState()).toBe("not_ready");
    expect(resetLocalSyncState).toHaveBeenCalledTimes(1);
    expect(getNotices()).toContainEqual({
      message:
        "Remote vault access is no longer available. Synch disconnected this Obsidian vault.",
      timeout: undefined,
    });
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
