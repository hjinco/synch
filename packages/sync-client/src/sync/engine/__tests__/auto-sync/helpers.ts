import { afterEach, vi } from "vitest";

import type { SyncTokenResponse } from "../../../remote/client";
import type {
  CommitMutationPayload,
  SyncRealtimeCallbacks,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";
import type { PushPendingMutationsResult } from "../../push-service";

afterEach(() => {
  vi.useRealTimers();
});

export function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
    syncFormatVersion: 1,
  };
}

export function createPushResult(
  overrides: Partial<PushPendingMutationsResult> = {},
): PushPendingMutationsResult {
  return {
    cursor: 1,
    mutationsPushed: 1,
    mutationsRequeued: 0,
    filesCreatedOrUpdated: 1,
    filesDeleted: 0,
    conflictsCreated: 0,
    shouldPullAfterPush: false,
    hasMore: false,
    ...overrides,
  };
}

export function createFailingRealtimeClient(): {
  openSession: (
    _apiBaseUrl: string,
    _token: SyncTokenResponse,
    _lastKnownCursor: number,
    _callbacks: SyncRealtimeCallbacks,
  ) => Promise<SyncRealtimeSession>;
} {
  return {
    async openSession() {
      throw new Error("offline");
    },
  };
}

export function createRealtimeClient(
  onOpen?: (callbacks: SyncRealtimeCallbacks) => void,
  onSession?: (session: SyncRealtimeSession) => void,
  serverCursor = 0,
): {
  openSession: (
    _apiBaseUrl: string,
    _token: SyncTokenResponse,
    _lastKnownCursor: number,
    callbacks: SyncRealtimeCallbacks,
  ) => Promise<SyncRealtimeSession>;
} {
  return {
    async openSession(_apiBaseUrl, _token, _lastKnownCursor, callbacks) {
      onOpen?.(callbacks);
      const session: SyncRealtimeSession = {
        serverCursor,
        storageUsedBytes: 0,
        storageLimitBytes: 100_000_000,
        maxFileSizeBytes: 3_000_000,
        watchStorageStatus() {},
        unwatchStorageStatus() {},
        async listEntryStates() {
          return {
            targetCursor: 0,
            totalEntries: 0,
            hasMore: false,
            nextAfter: null,
            entries: [],
          };
        },
        async listEntryVersions() {
          throw new Error("auto-sync tests should not list entry versions");
        },
        async listDeletedEntries() {
          throw new Error("auto-sync tests should not list deleted entries");
        },
        async restoreEntryVersion() {
          throw new Error("auto-sync tests should not restore entry versions");
	        },
        async restoreEntryVersions() {
          throw new Error("auto-sync tests should not restore entry versions");
        },
        async purgeDeletedEntries() {
          throw new Error("auto-sync tests should not purge deleted entries");
        },
	        async detachLocalVault() {},
	        async commitMutation(_mutation: CommitMutationPayload) {
          return {
            cursor: 1,
            entryId: "entry-1",
            revision: 1,
          };
        },
        async commitMutations(mutations) {
          return {
            cursor: mutations.length,
            results: mutations.map((mutation, index) => ({
              status: "accepted" as const,
              mutationId: mutation.mutationId,
              cursor: index + 1,
              entryId: mutation.entryId,
              revision: mutation.baseRevision + 1,
            })),
          };
        },
        close() {},
      };
      onSession?.(session);
      return session;
    },
  };
}
