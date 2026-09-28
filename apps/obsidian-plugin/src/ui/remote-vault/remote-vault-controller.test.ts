import { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/core";
import { getButtonComponents, getOpenModals, getCreatedElementTexts, getTextComponents, resetObsidianMocks, setLanguage } from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import type { SharingManager } from "@synch/sync-client/remote";
import type { RemoteVaultPort } from "./ports";
import {
  SynchRemoteVaultController,
  type RemoteVaultSyncPort,
  type SynchRemoteVaultControllerDeps,
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
      createVaultAccessContext: vi.fn(),
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

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const latestButton = (text: string) => getButtonComponents().findLast((button) => button.text === text)!;

function connectionFixture(role: "owner" | "member", files: string[]) {
  const plugin = new Plugin();
  Object.assign(plugin.app, {
    vault: {
      configDir: ".obsidian",
      getFiles: () => files.map((path) => ({ path })),
      adapter: { list: async () => ({ files: [], folders: [] }) },
    },
  });
  const bootstrap = vi.fn(async (_input, beforeActivate) => { await beforeActivate(); });
  const deps: SynchRemoteVaultControllerDeps = {
    plugin,
    remoteVaultManager: { bootstrapRemoteVault: bootstrap } as unknown as RemoteVaultPort,
    syncController: {} as RemoteVaultSyncPort,
    clearSyncTokenState: vi.fn(), getApiBaseUrl: () => "https://api.synch.run",
    getSyncFileRules: () => ({ ...DEFAULT_SYNC_FILE_RULES }),
    getStoredRemoteVaultId: () => null,
    createVaultAccessContext: vi.fn(async () => ({
      manager: { client: { organizations: async () => [{
        name: "Team", sharing: { enabled: true },
        vaults: [{ id: "vault", name: "Notes", personal: role === "owner", canManage: role === "owner", status: "active", shared: role !== "owner" }],
      }] } } as unknown as SharingManager,
      isCurrentAccount: () => true,
    })),
    hasConnectedRemoteVault: () => false,
    initializeSyncStoreForActiveRemoteVault: vi.fn(async () => {}),
    ensureAutoSyncState: vi.fn(async () => {}), resetSyncConnection: vi.fn(async () => {}),
    notifyError: vi.fn(),
  };
  return { controller: new SynchRemoteVaultController(deps), deps, bootstrap };
}

describe("connection flow wiring", () => {
  beforeEach(resetObsidianMocks);

  it("keeps personal file confirmation and starts sync only after connection succeeds", async () => {
    const { controller, deps, bootstrap } = connectionFixture("owner", ["note.md"]);
    const result = controller.connectRemoteVaultFromPrompt();
    await nextTask();
    await latestButton("Notes").click();
    await getTextComponents().at(-1)?.change("my password");
    const submission = latestButton(t("vault.connect")).click();
    await nextTask();
    expect(getCreatedElementTexts()).toContain(t("vault.connectExistingConflict"));
    expect(bootstrap).not.toHaveBeenCalled();
    await latestButton(t("connectAnyway")).click();
    await submission;
    await result;
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(deps.initializeSyncStoreForActiveRemoteVault).toHaveBeenCalledOnce();
    expect(deps.ensureAutoSyncState).toHaveBeenCalledOnce();
    expect(deps.notifyError).not.toHaveBeenCalled();
  });

  it("blocks invited vaults before offering a file merge or password", async () => {
    const { controller, deps, bootstrap } = connectionFixture("member", ["note.md"]);
    const result = controller.connectRemoteVaultFromPrompt();
    await nextTask();
    await latestButton("Notes").click();
    expect(getCreatedElementTexts()).toContain(t("vault.invitedNeedsEmpty"));
    expect(getCreatedElementTexts()).not.toContain(t("vault.connectExistingConflict"));
    expect(getTextComponents()).toHaveLength(0);
    getOpenModals().at(-1)?.close();
    await result;
    expect(bootstrap).not.toHaveBeenCalled();
    expect(deps.ensureAutoSyncState).not.toHaveBeenCalled();
  });

  it("prevents overlapping setup flows and allows reopening after cancellation", async () => {
    const { controller, deps } = connectionFixture("owner", []);
    const first = controller.connectRemoteVaultFromPrompt();
    await nextTask();
    await controller.connectRemoteVaultFromPrompt();
    await controller.createRemoteVaultFromPrompt();
    expect(deps.createVaultAccessContext).toHaveBeenCalledOnce();
    getOpenModals().at(-1)?.close();
    await first;
    const second = controller.connectRemoteVaultFromPrompt();
    await nextTask();
    expect(deps.createVaultAccessContext).toHaveBeenCalledTimes(2);
    getOpenModals().at(-1)?.close();
    await second;
  });
});
