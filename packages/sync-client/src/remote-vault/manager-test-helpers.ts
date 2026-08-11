import { vi } from "vitest";

import type { StoredRemoteVaultKeySecret } from "./types";
import {
  RemoteVaultManager,
  type RemoteVaultNoticeEvent,
} from "./manager";
import type {
  CreateRemoteVaultResponse,
  RemoteVaultBootstrapResponse,
  RemoteVaultSummaryResponse,
} from "./types";

type RemoteVaultClientOverrides = Partial<{
  createRemoteVault: (
    apiBaseUrl: string,
    sessionToken: string,
    input: unknown,
  ) => Promise<CreateRemoteVaultResponse>;
  getRemoteVaultBootstrap: (
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
  ) => Promise<RemoteVaultBootstrapResponse>;
  listRemoteVaults: (
    apiBaseUrl: string,
    sessionToken: string,
  ) => Promise<RemoteVaultSummaryResponse>;
}>;

export function createManager(input: {
  storedVaultId?: string | null;
  storedVault?: StoredRemoteVaultKeySecret | null;
  savedVaults?: Array<StoredRemoteVaultKeySecret | null>;
  refreshUi?: () => void;
  notify?: (event: RemoteVaultNoticeEvent) => void;
  remoteVaultClient?: RemoteVaultClientOverrides;
}) {
  return new RemoteVaultManager({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getAuthSessionToken: () => "session-token",
    hasAuthenticatedSession: () => true,
    getStoredRemoteVaultId: () => input.storedVaultId ?? null,
    getStoredRemoteVaultKeySecret: () => input.storedVault ?? null,
    saveStoredRemoteVaultKeySecret: async (vault) => {
      input.savedVaults?.push(vault);
    },
    refreshUi: input.refreshUi ?? vi.fn(),
    notify: input.notify ?? vi.fn(),
    remoteVaultClient: {
      createRemoteVault:
        input.remoteVaultClient?.createRemoteVault ??
        (async () => {
          throw new Error("createRemoteVault should not be called");
        }),
      getRemoteVaultBootstrap:
        input.remoteVaultClient?.getRemoteVaultBootstrap ??
        (async () => {
          throw new Error("getRemoteVaultBootstrap should not be called");
        }),
      listRemoteVaults:
        input.remoteVaultClient?.listRemoteVaults ??
        (async () => ({
          vaults: [],
        })),
    } as never,
  });
}

export function remoteVaultSummary(
  overrides: Partial<RemoteVaultSummaryResponse["vaults"][number]> = {},
): RemoteVaultSummaryResponse["vaults"][number] {
  return {
    id: "vault-remote",
    organizationId: "org-1",
    name: "Remote",
    activeKeyVersion: 1,
    createdAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}
