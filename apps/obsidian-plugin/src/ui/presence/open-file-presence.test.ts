import type { Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  SynchOpenFilePresence,
  type SynchPresenceHost,
} from "./open-file-presence";
import type { PresenceWorkspace } from "./open-paths";
import type { PresenceUpdatedPush } from "./presence-relay";

describe("open file presence", () => {
  it("watches every open markdown entry", async () => {
    const workspace = createWorkspace(["Active.md", "Other.md"]);
    const host = createHost({
      getPresenceEntryId: async (path) =>
        path === "Active.md" ? "entry-active" : "entry-other",
    });
    const presence = new SynchOpenFilePresence(
      createPlugin(workspace.workspace),
      host,
    );
    presence.initialize();
    await flushPromises();

    expect(host.watchPresence).toHaveBeenLastCalledWith([
      "entry-active",
      "entry-other",
    ]);
  });

  it("clears remote decorations when the watched entry changes", async () => {
    const workspace = createWorkspace("A.md");
    const host = createHost({
      getPresenceEntryId: async (path) => (path === "A.md" ? "entry-a" : "entry-b"),
      getPresencePath: async () => "A.md",
    });
    const presence = new SynchOpenFilePresence(
      createPlugin(workspace.workspace),
      host,
    );
    presence.initialize();
    await flushPromises();

    presence.onUpdated(presenceUpdate("peer-1", "entry-a"));
    await flushPromises();
    expect(lastPresenceValues(workspace.dispatch).carets).toHaveLength(1);

    workspace.setPath("B.md");
    workspace.trigger("active-leaf-change");
    await flushPromises();

    expect(lastPresenceValues(workspace.dispatch)).toEqual({
      carets: [],
      selections: [],
    });
    expect(host.watchPresence).toHaveBeenLastCalledWith(["entry-b"]);
  });

  it("does not restore a peer after it is cleared during path lookup", async () => {
    const workspace = createWorkspace("A.md");
    let resolvePath!: (path: string | null) => void;
    const pendingPath = new Promise<string | null>((resolve) => {
      resolvePath = resolve;
    });
    const host = createHost({
      getPresenceEntryId: async () => "entry-a",
      getPresencePath: () => pendingPath,
    });
    const presence = new SynchOpenFilePresence(
      createPlugin(workspace.workspace),
      host,
    );
    presence.initialize();
    await flushPromises();

    const dispatchCountBeforeUpdate = workspace.dispatch.mock.calls.length;
    presence.onUpdated(presenceUpdate("peer-1", "entry-a"));
    presence.onCleared("peer-1");
    resolvePath("A.md");
    await flushPromises();

    expect(workspace.dispatch.mock.calls.length).toBe(dispatchCountBeforeUpdate + 1);
    expect(lastPresenceValues(workspace.dispatch)).toEqual({
      carets: [],
      selections: [],
    });
  });
});

function createHost(
  overrides: Partial<SynchPresenceHost> = {},
): SynchPresenceHost & {
  watchPresence: ReturnType<typeof vi.fn>;
  updatePresence: ReturnType<typeof vi.fn>;
  clearPresence: ReturnType<typeof vi.fn>;
} {
  return {
    hasAuthenticatedSession: () => true,
    hasConnectedRemoteVault: () => true,
    getPresenceEntryId: vi.fn(async () => null),
    getPresencePath: vi.fn(async () => null),
    watchPresence: vi.fn(),
    unwatchPresence: vi.fn(),
    updatePresence: vi.fn(),
    clearPresence: vi.fn(),
    setPresenceRelay: vi.fn(),
    ...overrides,
  };
}

function createPlugin(workspace: PresenceWorkspace): Plugin {
  return {
    app: { workspace },
    registerEditorExtension: vi.fn(),
    registerDomEvent: vi.fn(),
    registerEvent: vi.fn(),
    registerInterval: (id: number) => {
      window.clearInterval(id);
      return id;
    },
    register: vi.fn(),
  } as unknown as Plugin;
}

function createWorkspace(paths: string | string[]) {
  const listeners = new Map<string, () => void>();
  const dispatch = vi.fn();
  const workspaceLeaves = (Array.isArray(paths) ? paths : [paths]).map((path) => ({
    view: {
      file: { path },
      editor: {
        cm: { dispatch },
      },
    },
  }));
  const activeLeaf = workspaceLeaves[0];
  const workspace = {
    getLeavesOfType: () => workspaceLeaves,
    activeLeaf,
    on(event: string, callback: () => void) {
      listeners.set(event, callback);
      return { unsubscribe: () => listeners.delete(event) };
    },
  } as unknown as PresenceWorkspace;

  return {
    workspace,
    dispatch,
    setPath(nextPath: string) {
      if (activeLeaf) {
        activeLeaf.view.file.path = nextPath;
      }
    },
    trigger(event: string) {
      listeners.get(event)?.();
    },
  };
}

function presenceUpdate(
  presenceId: string,
  entryId: string,
): PresenceUpdatedPush {
  return {
    presenceId,
    entryId,
    userId: "user-2",
    displayName: "Peer",
    selection: {
      anchor: { line: 1, ch: 2 },
      head: { line: 1, ch: 2 },
    },
  };
}

function lastPresenceValues(dispatch: ReturnType<typeof vi.fn>): {
  carets: unknown[];
  selections: unknown[];
} {
  const transaction = dispatch.mock.lastCall?.[0] as {
    effects?: Array<{ value: unknown }>;
  } | undefined;
  const effects = transaction?.effects ?? [];
  return {
    carets: (effects[0]?.value as unknown[] | undefined) ?? [],
    selections: (effects[1]?.value as unknown[] | undefined) ?? [],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
