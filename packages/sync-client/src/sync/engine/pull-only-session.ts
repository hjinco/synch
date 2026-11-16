import type { SyncTokenResponse } from "../remote/client";
import {
  SyncRealtimeError,
  type SyncRealtimeClient,
  type SyncRealtimeSession,
} from "../remote/realtime-client";
import type { SyncCursorStore, SyncMutationStore } from "../store/ports";

interface PullOnlySessionDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => (SyncCursorStore & SyncMutationStore) | null;
  realtimeClient: Pick<SyncRealtimeClient, "openSession">;
  pullOnce: (session: SyncRealtimeSession) => Promise<unknown>;
}

/** The caller must stop automatic sync and wait for in-flight work first. */
export async function pullWithReadOnlySession(deps: PullOnlySessionDeps): Promise<void> {
  const store = deps.getSyncStore();
  if (!store) {
    throw new Error("Sync store is not initialized.");
  }

  const pendingMutations = await store.listDirtyEntries(1);
  if (pendingMutations.length > 0) {
    throw new Error(
      "Pull-only sync requires a read-only replica with no pending local changes. Use a fresh backup directory or resolve the pending changes with `synch sync` first.",
    );
  }

  const token = await deps.getSyncToken();
  const cursor = await store.getCursor();
  let sessionError: Error | null = null;
  const throwIfSessionFailed = () => {
    if (sessionError) {
      throw sessionError;
    }
  };
  const session = await deps.realtimeClient.openSession(
    deps.getApiBaseUrl(),
    token,
    cursor,
    {
      onCursorAdvanced() {},
      onStorageStatusUpdated() {},
      onPolicyUpdated() {},
      onPresenceUpdated() {},
      onPresenceCleared() {},
      onPresenceAvailabilityChanged() {},
      onClose() {},
      onError(error) {
        sessionError ??= error;
      },
    },
  );

  try {
    if (cursor > session.serverCursor) {
      throw new SyncRealtimeError(
        "cursor_ahead_of_server",
        "This device's sync history no longer matches the remote vault. Move .synch/sync.sqlite aside, then run `synch vault connect --vault-id <id>` to rebuild this read-only replica's sync state.",
      );
    }
    throwIfSessionFailed();
    await deps.pullOnce(session);
    throwIfSessionFailed();
  } finally {
    session.close();
  }
}
