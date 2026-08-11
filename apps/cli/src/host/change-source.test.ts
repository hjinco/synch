import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  type SyncFileRules,
} from "@synch/sync-client/sync/core/file-rules";
import type { SyncChangeSourceContext } from "@synch/sync-client/sync/runtime/change-source";
import { NodeFsChangeSource } from "./change-source";
import { NodeSyncVaultAdapter, VAULT_TMP_FILE_MARKER } from "./vault-adapter";

let vaultPath: string;
let source: NodeFsChangeSource;

const rules: SyncFileRules = { ...DEFAULT_SYNC_FILE_RULES, includedHiddenFolders: [] };

function createContext() {
  const recordUpsert = vi.fn(async () => true);
  const recordDelete = vi.fn(async () => true);
  const recordRename = vi.fn(async () => true);
  const notifyLocalChange = vi.fn();
  const errors: unknown[] = [];
  const context: SyncChangeSourceContext = {
    eventRecorder: { recordUpsert, recordDelete, recordRename },
    notifyLocalChange,
    runLocalMutationWork: async (work) => await work(),
    hasActiveRemoteVaultSession: () => true,
    onError: (error) => {
      errors.push(error);
    },
  };
  return { context, recordUpsert, recordDelete, notifyLocalChange, errors };
}

beforeEach(() => {
  // Resolve symlinked tmpdirs (e.g. /var -> /private/var on macOS) so watcher
  // event paths match the configured vault path.
  vaultPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synch-watch-")));
  source = new NodeFsChangeSource({
    vaultPath,
    vaultAdapter: new NodeSyncVaultAdapter({
      vaultPath,
      getConfigDir: () => ".obsidian",
      getSyncFileRules: () => rules,
    }),
    eventDebounceMs: 10,
    reconcileDebounceMs: 10,
    // Native FS events can drop changes made right after the watcher becomes
    // ready (see NodeFsChangeSourceDeps.usePolling); poll for determinism.
    usePolling: true,
  });
});

afterEach(() => {
  source.stop();
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Watcher setup and event delivery can be slow when test files run in
// parallel, so every test here gets a generous timeout.
describe("NodeFsChangeSource", { timeout: 15_000 }, () => {
  it("records an upsert with file contents when a file is created", async () => {
    const { context, recordUpsert, notifyLocalChange } = createContext();
    source.start(context);
    await source.whenReady();

    fs.writeFileSync(path.join(vaultPath, "note.md"), "hello");

    await vi.waitFor(() => {
      expect(recordUpsert).toHaveBeenCalled();
    }, { timeout: 10_000 });
    const [recordedPath, bytes, stat] = recordUpsert.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      { mtime: number; size: number },
    ];
    expect(recordedPath).toBe("note.md");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(stat.size).toBe(5);
    expect(notifyLocalChange).toHaveBeenCalled();
  });

  it("records upserts for files inside newly created folders", async () => {
    const { context, recordUpsert } = createContext();
    source.start(context);
    await source.whenReady();

    fs.mkdirSync(path.join(vaultPath, "notes", "deep"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, "notes", "deep", "a.md"), "x");

    await vi.waitFor(() => {
      expect(recordUpsert).toHaveBeenCalledWith(
        "notes/deep/a.md",
        expect.anything(),
        expect.anything(),
      );
    }, { timeout: 10_000 });
  });

  it("records a delete when a file is removed", async () => {
    fs.writeFileSync(path.join(vaultPath, "gone.md"), "bye");
    const { context, recordDelete } = createContext();
    source.start(context);
    await source.whenReady();

    fs.unlinkSync(path.join(vaultPath, "gone.md"));

    await vi.waitFor(() => {
      expect(recordDelete).toHaveBeenCalledWith("gone.md");
    }, { timeout: 10_000 });
  });

  it("ignores the .synch state dir and atomic-write temp files", async () => {
    const { context, recordUpsert, recordDelete } = createContext();
    source.start(context);
    await source.whenReady();

    fs.mkdirSync(path.join(vaultPath, ".synch"));
    fs.writeFileSync(path.join(vaultPath, ".synch", "sync.sqlite"), "db");
    fs.writeFileSync(path.join(vaultPath, `${VAULT_TMP_FILE_MARKER}abc`), "tmp");
    fs.writeFileSync(path.join(vaultPath, "real.md"), "note");

    await vi.waitFor(() => {
      expect(recordUpsert).toHaveBeenCalledWith(
        "real.md",
        expect.anything(),
        expect.anything(),
      );
    }, { timeout: 10_000 });
    const recordedPaths = recordUpsert.mock.calls.map((call) => call[0] as unknown);
    expect(recordedPaths).toEqual(["real.md"]);
    expect(recordDelete).not.toHaveBeenCalled();
  });

  it("stops delivering events after stop()", async () => {
    const { context, recordUpsert } = createContext();
    source.start(context);
    await source.whenReady();
    source.stop();

    fs.writeFileSync(path.join(vaultPath, "late.md"), "late");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recordUpsert).not.toHaveBeenCalled();
  });
});
