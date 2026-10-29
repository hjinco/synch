import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type Plugin } from "obsidian";

import { SynchConflictController } from "./conflict-controller";

interface FakeFile {
  path: string;
  content: string | Uint8Array;
  mtime: number;
  size: number;
}

/**
 * Minimal in-memory vault: enough to exercise the controller's listing and
 * resolution paths without Obsidian. Uses the real `TFile`/`TFolder` test stubs
 * so the controller's `instanceof` checks behave as they do at runtime.
 */
function createVault(initial: FakeFile[]) {
  const withStat = (file: FakeFile) => {
    const handle = new TFile(file.path);
    // The controller reads `stat`, which Obsidian populates on real vault files.
    Object.assign(handle, { stat: { size: file.size, mtime: file.mtime } });
    return { ...file, handle };
  };
  const files = new Map(initial.map((file) => [file.path, withStat(file)]));
  const folders = new Set<string>();

  const text = (content: string | Uint8Array): string =>
    typeof content === "string" ? content : new TextDecoder().decode(content);
  const handleFor = (path: string) => files.get(path)?.handle;

  return {
    files,
    folders,
    trashed: [] as string[],
    getFiles: () => [...files.values()].map((file) => file.handle),
    getAbstractFileByPath: (path: string) =>
      handleFor(path) ?? (folders.has(path) ? new TFolder(path) : null),
    cachedRead: async (target: { path: string }) => text(files.get(target.path)!.content),
    // Preserve raw bytes rather than round-tripping through a string, so a
    // binary fixture stays binary.
    readBinary: async (target: { path: string }) => {
      const content = files.get(target.path)!.content;
      const bytes = typeof content === "string"
        ? new TextEncoder().encode(content)
        : content;
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    },
    modify: async (target: { path: string }, content: string) => {
      const file = files.get(target.path);
      if (file) {
        file.content = content;
        file.size = content.length;
        Object.assign(file.handle, { stat: { size: file.size, mtime: file.mtime } });
      }
    },
    // Like Vault.process, invoke the synchronous callback and commit without
    // an awaited boundary between reading the current content and writing it.
    process: async (target: { path: string }, update: (current: string) => string) => {
      const file = files.get(target.path);
      if (!file) throw new Error(`File not found: ${target.path}`);
      const content = update(text(file.content));
      file.content = content;
      file.size = content.length;
      Object.assign(file.handle, { stat: { size: file.size, mtime: file.mtime } });
      return content;
    },
    modifyBinary: async (target: { path: string }, content: ArrayBuffer) => {
      const file = files.get(target.path);
      if (file) {
        file.content = new Uint8Array(content.slice(0));
        file.size = content.byteLength;
        Object.assign(file.handle, { stat: { size: file.size, mtime: file.mtime } });
      }
    },
    create: async (path: string, content: string) => {
      files.set(path, withStat({ path, content, mtime: 0, size: content.length }));
    },
    createBinary: async (path: string, content: ArrayBuffer) => {
      const bytes = new Uint8Array(content.slice(0));
      files.set(path, withStat({ path, content: bytes, mtime: 0, size: bytes.byteLength }));
    },
    createFolder: async (path: string) => {
      folders.add(path);
    },
    delete: async (target: { path: string }) => {
      files.delete(target.path);
    },
  };
}

function createController(vault: ReturnType<typeof createVault>) {
  const plugin = {
    app: {
      vault: { ...vault, configDir: ".obsidian" },
      // Resolution deletes through FileManager so the user's trash preference
      // is honoured; the fake records the call instead of deleting directly.
      fileManager: {
        trashFile: async (target: { path: string }) => {
          vault.files.delete(target.path);
          vault.trashed.push(target.path);
        },
      },
      workspace: { getLeavesOfType: () => [] },
    },
  } as unknown as Plugin;

  return new SynchConflictController({ plugin });
}

describe("SynchConflictController resolution", () => {
  it("keeps the original by deleting only the copy", async () => {
    const vault = createVault([
      { path: "note.md", content: "original\n", mtime: 1, size: 9 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "copy\n",
        mtime: 2,
        size: 5,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "note.sync-conflict-20260424-001419.md",
      "keep-original",
    );

    expect(vault.files.get("note.md")?.content).toBe("original\n");
    expect(vault.files.has("note.sync-conflict-20260424-001419.md")).toBe(false);
  });

  it("preserves the copy when the original disappears after previewing keep-original", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const vault = createVault([
      { path: "note.md", content: "original\n", mtime: 1, size: 9 },
      { path: copyPath, content: "copy\n", mtime: 2, size: 5 },
    ]);
    const controller = createController(vault);

    expect(await controller.previewConflict(copyPath)).toEqual({
      original: "original\n",
      copy: "copy\n",
      merged: null,
    });
    // Sync deletes the original while the user is deciding in the modal.
    await vault.delete(vault.files.get("note.md")!.handle);

    await expect.soft(
      controller.resolveConflict(copyPath, "keep-original"),
    ).rejects.toThrow();

    expect.soft(vault.files.has("note.md")).toBe(false);
    expect.soft(vault.files.get(copyPath)?.content).toBe("copy\n");
    expect.soft(vault.trashed).toEqual([]);
  });

  it("keeps the copy by overwriting the original and removing the copy", async () => {
    const vault = createVault([
      { path: "note.md", content: "original\n", mtime: 1, size: 9 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "copy\n",
        mtime: 2,
        size: 5,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "note.sync-conflict-20260424-001419.md",
      "keep-copy",
    );

    expect(new TextDecoder().decode(vault.files.get("note.md")?.content as Uint8Array))
      .toBe("copy\n");
    expect(vault.files.has("note.sync-conflict-20260424-001419.md")).toBe(false);
  });

  it("keeps binary conflict copies byte-for-byte", async () => {
    const originalBytes = new Uint8Array([0x00, 0x7f, 0x80]);
    const copyBytes = new Uint8Array([0xff, 0x00, 0x81, 0x42]);
    const vault = createVault([
      { path: "image.png", content: originalBytes, mtime: 1, size: originalBytes.length },
      {
        path: "image.sync-conflict-20260424-001419.png",
        content: copyBytes,
        mtime: 2,
        size: copyBytes.length,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "image.sync-conflict-20260424-001419.png",
      "keep-copy",
    );

    expect(Array.from(vault.files.get("image.png")?.content as Uint8Array))
      .toEqual(Array.from(copyBytes));
    expect(vault.files.has("image.sync-conflict-20260424-001419.png")).toBe(false);
  });

  it("recreates a deleted original when the copy is kept", async () => {
    const vault = createVault([
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "copy\n",
        mtime: 2,
        size: 5,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "note.sync-conflict-20260424-001419.md",
      "keep-copy",
    );

    expect(new TextDecoder().decode(vault.files.get("note.md")?.content as Uint8Array))
      .toBe("copy\n");
  });

  it("refuses to merge when the original is not a prefix of the copy", async () => {
    // Without a stored common ancestor there is no way to know which side made
    // which change, so a rewrite must not be reported as a merge.
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "two\n",
        mtime: 2,
        size: 4,
      },
    ]);
    const controller = createController(vault);

    await expect(
      controller.resolveConflict(
        "note.sync-conflict-20260424-001419.md",
        "merge",
        await controller.previewConflict("note.sync-conflict-20260424-001419.md"),
      ),
    ).rejects.toThrow();

    // Nothing was written and nothing was deleted.
    expect(vault.files.get("note.md")?.content).toBe("one\n");
    expect(vault.files.has("note.sync-conflict-20260424-001419.md")).toBe(true);
  });

  it("refuses to merge when the copy rewrote a line, even though the copy is longer", async () => {
    const vault = createVault([
      { path: "note.md", content: "Title\n\nbody\n", mtime: 1, size: 15 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "New title\n\nbody\nmore\n",
        mtime: 2,
        size: 24,
      },
    ]);
    const controller = createController(vault);

    await expect(
      controller.resolveConflict(
        "note.sync-conflict-20260424-001419.md",
        "merge",
        await controller.previewConflict("note.sync-conflict-20260424-001419.md"),
      ),
    ).rejects.toThrow();
    expect(vault.files.get("note.md")?.content).toBe("Title\n\nbody\n");
  });

  it("merges when the copy only appended to the original, losing nothing", async () => {
    const vault = createVault([
      { path: "note.md", content: "Title\n\nbody\n", mtime: 1, size: 15 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "Title\n\nbody\nappended\n",
        mtime: 2,
        size: 24,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "note.sync-conflict-20260424-001419.md",
      "merge",
      await controller.previewConflict("note.sync-conflict-20260424-001419.md"),
    );

    expect(vault.files.get("note.md")?.content).toBe("Title\n\nbody\nappended\n");
    expect(vault.files.has("note.sync-conflict-20260424-001419.md")).toBe(false);
  });

  it("aborts merge and preserves both files when the original changes during the copy read", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const copyContent = "one\nfrom copy\n";
    const concurrentContent = "one\nconcurrent edit\n";
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: copyPath, content: copyContent, mtime: 2, size: copyContent.length },
    ]);
    const readBinary = vault.readBinary;
    let concurrentEditApplied = false;
    // Install before createController: its plugin receives a spread of the vault.
    vi.spyOn(vault, "readBinary").mockImplementation(async (target) => {
      if (target.path === copyPath && !concurrentEditApplied) {
        // The original has already been read. Simulate sync or another plugin
        // editing it at this awaited I/O boundary, without timers or sleeps.
        await vault.modify(vault.files.get("note.md")!.handle, concurrentContent);
        concurrentEditApplied = true;
      }
      return await readBinary(target);
    });
    const controller = createController(vault);

    await expect.soft(
      controller.resolveConflict(copyPath, "merge", {
        original: "one\n", copy: copyContent, merged: copyContent,
      }),
    ).rejects.toThrow();

    expect(concurrentEditApplied).toBe(true);
    expect.soft(vault.files.get("note.md")?.content).toBe(concurrentContent);
    expect.soft(vault.files.get(copyPath)?.content).toBe(copyContent);
    expect.soft(vault.trashed).toEqual([]);
  });

  it("checks the original inside the atomic merge update, not before it", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: copyPath, content: "one\ncopy\n", mtime: 2, size: 9 },
    ]);
    const process = vault.process;
    const processSpy = vi.spyOn(vault, "process").mockImplementation(async (target, update) => {
      // An edit lands after any preflight checks but before process acquires
      // the original's current content and invokes the update callback.
      await vault.modify(target, "one\nconcurrent\n");
      return await process(target, update);
    });
    const controller = createController(vault);

    await expect(controller.resolveConflict(copyPath, "merge", {
      original: "one\n", copy: "one\ncopy\n", merged: "one\ncopy\n",
    })).rejects.toThrow();

    expect(processSpy).toHaveBeenCalledOnce();
    expect(vault.files.get("note.md")?.content).toBe("one\nconcurrent\n");
    expect(vault.files.get(copyPath)?.content).toBe("one\ncopy\n");
    expect(vault.trashed).toEqual([]);
  });

  it.each(["original", "copy"] as const)(
    "aborts without writing or deleting when the %s differs from the displayed preview",
    async (side) => {
      const copyPath = "note.sync-conflict-20260424-001419.md";
      const vault = createVault([
        { path: "note.md", content: "one\n", mtime: 1, size: 4 },
        { path: copyPath, content: "one\ncopy\n", mtime: 2, size: 9 },
      ]);
      const processSpy = vi.spyOn(vault, "process");
      const controller = createController(vault);
      const displayed = await controller.previewConflict(copyPath);
      const changedPath = side === "original" ? "note.md" : copyPath;
      // Both updated pairs remain mergeable: re-computing from the latest
      // contents alone must not silently accept a diff the user never saw.
      const changedContent = side === "original" ? "" : "one\ncopy\nnew edit\n";
      await vault.modify(vault.files.get(changedPath)!.handle, changedContent);

      await expect(controller.resolveConflict(copyPath, "merge", displayed))
        .rejects.toThrow("The files changed");

      expect(processSpy).not.toHaveBeenCalled();
      expect(vault.files.get("note.md")?.content).toBe(side === "original" ? "" : "one\n");
      expect(vault.files.get(copyPath)?.content).toBe(side === "copy" ? changedContent : "one\ncopy\n");
      expect(vault.trashed).toEqual([]);
    },
  );

  it("rejects merging without a displayed preview", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: copyPath, content: "one\ncopy\n", mtime: 2, size: 9 },
    ]);
    const controller = createController(vault);

    await expect(controller.resolveConflict(copyPath, "merge"))
      .rejects.toThrow("Open the conflict comparison");
    expect(vault.files.get("note.md")?.content).toBe("one\n");
    expect(vault.files.has(copyPath)).toBe(true);
    expect(vault.trashed).toEqual([]);
  });

  it("preserves the copy if the merge write fails", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: copyPath, content: "one\ncopy\n", mtime: 2, size: 9 },
    ]);
    vi.spyOn(vault, "process").mockRejectedValue(new Error("Write failed"));
    const controller = createController(vault);
    const displayed = await controller.previewConflict(copyPath);

    await expect(controller.resolveConflict(copyPath, "merge", displayed))
      .rejects.toThrow("Write failed");
    expect(vault.files.get("note.md")?.content).toBe("one\n");
    expect(vault.files.get(copyPath)?.content).toBe("one\ncopy\n");
    expect(vault.trashed).toEqual([]);
  });

  it("waits for the merge write to succeed before deleting, without post-write reads", async () => {
    const copyPath = "note.sync-conflict-20260424-001419.md";
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: copyPath, content: "one\ncopy\n", mtime: 2, size: 9 },
    ]);
    let finishWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => { finishWrite = resolve; });
    const process = vault.process;
    const processSpy = vi.spyOn(vault, "process").mockImplementation(async (target, update) => {
      await writeReady;
      return await process(target, update);
    });
    const readSpy = vi.spyOn(vault, "readBinary");
    const controller = createController(vault);
    const displayed = await controller.previewConflict(copyPath);
    readSpy.mockClear();

    const resolution = controller.resolveConflict(copyPath, "merge", displayed);
    await vi.waitFor(() => expect(processSpy).toHaveBeenCalledOnce());
    expect(vault.files.has(copyPath)).toBe(true);
    expect(vault.trashed).toEqual([]);
    finishWrite();
    await resolution;

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(vault.files.get("note.md")?.content).toBe(displayed?.merged);
    expect(vault.files.has(copyPath)).toBe(false);
    expect(vault.trashed).toEqual([copyPath]);
  });

  it("removes the copy through the trash, respecting the user's preference", async () => {
    const vault = createVault([
      { path: "note.md", content: "original\n", mtime: 1, size: 9 },
      {
        path: "note.sync-conflict-20260424-001419.md",
        content: "copy\n",
        mtime: 2,
        size: 5,
      },
    ]);
    const controller = createController(vault);

    await controller.resolveConflict(
      "note.sync-conflict-20260424-001419.md",
      "keep-original",
    );

    // A conflict copy is the only record of unmerged content, so discarding it
    // must go through FileManager rather than a hard delete.
    expect(vault.trashed).toEqual(["note.sync-conflict-20260424-001419.md"]);
  });

  it("rejects a path that is not a conflict copy", async () => {
    const vault = createVault([{ path: "note.md", content: "x\n", mtime: 1, size: 2 }]);
    const controller = createController(vault);

    await expect(controller.resolveConflict("note.md", "keep-copy")).rejects.toThrow();
    expect(vault.files.get("note.md")?.content).toBe("x\n");
  });
});

describe("SynchConflictController preview", () => {
  it("reports a mergeable pair when the copy only appended", async () => {
    const vault = createVault([
      { path: "note.md", content: "a\nb\n", mtime: 1, size: 4 },
      { path: "note.sync-conflict-20260424-001419.md", content: "a\nb\nc\n", mtime: 2, size: 6 },
    ]);
    const controller = createController(vault);

    const preview = await controller.previewConflict(
      "note.sync-conflict-20260424-001419.md",
    );

    expect(preview).not.toBeNull();
    expect(preview?.merged).toBe("a\nb\nc\n");
  });

  it("reports no merge for edits that rewrite existing lines", async () => {
    const vault = createVault([
      { path: "note.md", content: "one\n", mtime: 1, size: 4 },
      { path: "note.sync-conflict-20260424-001419.md", content: "two\n", mtime: 2, size: 4 },
    ]);
    const controller = createController(vault);

    const preview = await controller.previewConflict(
      "note.sync-conflict-20260424-001419.md",
    );

    expect(preview?.merged).toBeNull();
  });

  it("returns null for a non-text file", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const vault = createVault([
      { path: "image.png", content: bytes, mtime: 1, size: 4 },
      { path: "image.sync-conflict-20260424-001419.png", content: bytes, mtime: 2, size: 4 },
    ]);
    const controller = createController(vault);

    expect(
      await controller.previewConflict("image.sync-conflict-20260424-001419.png"),
    ).toBeNull();
  });
});

describe("SynchConflictController listing", () => {
  it("hides a conflict for this session only", async () => {
    const vault = createVault([
      { path: "note.md", content: "a\n", mtime: 1, size: 2 },
      { path: "note.sync-conflict-20260424-001419.md", content: "b\n", mtime: 2, size: 2 },
    ]);
    const controller = createController(vault);

    expect(await controller.listConflicts()).toHaveLength(1);
    controller.hideConflict("note.sync-conflict-20260424-001419.md");
    expect(await controller.listConflicts()).toHaveLength(0);
    // Hiding does not touch the file.
    expect(vault.files.has("note.sync-conflict-20260424-001419.md")).toBe(true);
  });
});

describe("SynchConflictController pane", () => {
  function createPaneController(existingLeaves: Array<{ id: string }>) {
    const createdLeaf = { id: "created", setViewState: vi.fn(async () => undefined) };
    const workspace = {
      getLeavesOfType: vi.fn(() => existingLeaves),
      getRightLeaf: vi.fn(() => createdLeaf),
      revealLeaf: vi.fn(async () => undefined),
    };
    const plugin = { app: { workspace } } as unknown as Plugin;
    const controller = new SynchConflictController({ plugin });
    return { controller, workspace, createdLeaf };
  }

  it("reveals the existing leaf instead of creating another", async () => {
    const existing = { id: "existing" };
    const { controller, workspace } = createPaneController([existing]);

    await controller.openPane();

    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("creates the view in a right sidebar leaf when none exists", async () => {
    const { controller, workspace, createdLeaf } = createPaneController([]);

    await controller.openPane();

    expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
    expect(createdLeaf.setViewState).toHaveBeenCalledWith({
      type: "synch-conflict-view",
      active: true,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(createdLeaf);
  });
});
