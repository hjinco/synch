import type { Plugin, TAbstractFile, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { SyncEventRecorder } from "@synch/sync-client/sync/engine/event-recorder";
import type { ObsidianSyncVaultAdapter } from "../vault/obsidian-vault-adapter";
import { SyncVaultEventHandler } from "./vault-event-handler";

type VaultEventCallback = (...args: unknown[]) => void;
type VaultEventName = "create" | "modify" | "rename" | "delete";

describe("SyncVaultEventHandler", () => {
  it("records vault events in the order Obsidian emits them", async () => {
    const read = createDeferred<Uint8Array>();
    const recorded: string[] = [];
    const callbacks: Partial<Record<"modify" | "delete", VaultEventCallback>> = {};
    const plugin = createPlugin(callbacks);
    const notifyLocalChange = vi.fn();
    const onError = vi.fn();
    const onFileQueued = vi.fn();
    const runLocalMutationWork = createSerialQueue();
    const handler = new SyncVaultEventHandler({
      plugin,
      vaultAdapter: {
        asSyncableFile: (file: TAbstractFile) => file as TFile,
        isSyncablePath: () => true,
        readFile: async () => await read.promise,
      } as unknown as ObsidianSyncVaultAdapter,
      eventRecorder: {
        async recordUpsert(path, bytes) {
          recorded.push(`upsert:${path}:${new TextDecoder().decode(bytes)}`);
          return true;
        },
        async recordDelete(path) {
          recorded.push(`delete:${path}`);
          return true;
        },
        async recordRename() {
          throw new Error("rename should not be recorded in this test");
        },
      } satisfies Pick<SyncEventRecorder, "recordUpsert" | "recordRename" | "recordDelete">,
      autoLoop: { notifyLocalChange },
      runLocalMutationWork,
      hasActiveRemoteVaultSession: () => true,
      onError,
      onFileQueued,
    });

    handler.register();
    callbacks.modify?.(createFile("note.md"));
    callbacks.delete?.(createFile("note.md"));
    await nextTask();

    expect(recorded).toEqual([]);

    read.resolve(new TextEncoder().encode("modified"));
    await eventually(() => {
      expect(recorded).toEqual(["upsert:note.md:modified", "delete:note.md"]);
    });
    expect(notifyLocalChange).toHaveBeenCalledTimes(2);
    expect(onFileQueued).toHaveBeenNthCalledWith(1, {
      operation: "modify",
      path: "note.md",
      oldPath: undefined,
    });
    expect(onFileQueued).toHaveBeenNthCalledWith(2, {
      operation: "delete",
      path: "note.md",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores files filtered out by the vault adapter before scheduling work", async () => {
    const callbacks: Partial<Record<VaultEventName, VaultEventCallback>> = {};
    const plugin = createPlugin(callbacks);
    const notifyLocalChange = vi.fn();
    const runLocalMutationWork = vi.fn(async (work: () => Promise<void>) => await work());
    const recordUpsert = vi.fn();
    const recordRename = vi.fn();
    const recordDelete = vi.fn();
    const handler = new SyncVaultEventHandler({
      plugin,
      vaultAdapter: {
        asSyncableFile: () => null,
        isSyncablePath: () => false,
        readFile: async () => new Uint8Array(),
      } as unknown as ObsidianSyncVaultAdapter,
      eventRecorder: {
        recordUpsert,
        recordRename,
        recordDelete,
      } satisfies Pick<SyncEventRecorder, "recordUpsert" | "recordRename" | "recordDelete">,
      autoLoop: { notifyLocalChange },
      runLocalMutationWork,
      hasActiveRemoteVaultSession: () => true,
      onError: vi.fn(),
    });

    handler.register();
    callbacks.create?.(createFile("large.md", 101));
    callbacks.modify?.(createFile("large.md", 101));
    callbacks.rename?.(createFile("large.md", 101), "old-large.md");
    callbacks.delete?.(createFile("large.md", 101));
    await nextTask();

    expect(runLocalMutationWork).not.toHaveBeenCalled();
    expect(recordUpsert).not.toHaveBeenCalled();
    expect(recordRename).not.toHaveBeenCalled();
    expect(recordDelete).not.toHaveBeenCalled();
    expect(notifyLocalChange).not.toHaveBeenCalled();
  });
});

function createPlugin(
  callbacks: Partial<Record<VaultEventName, VaultEventCallback>>,
): Plugin {
  return {
    registerEvent: vi.fn(),
    app: {
      vault: {
        on: vi.fn((eventName: string, callback: VaultEventCallback) => {
          if (
            eventName === "create" ||
            eventName === "modify" ||
            eventName === "rename" ||
            eventName === "delete"
          ) {
            callbacks[eventName] = callback;
          }
          return {};
        }),
      },
    },
  } as unknown as Plugin;
}

function createFile(path: string, size = 0): TFile {
  return { path, stat: { size } } as TFile;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await nextTask();
    }
  }

  throw lastError;
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
