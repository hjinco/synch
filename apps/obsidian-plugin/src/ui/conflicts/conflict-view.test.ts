import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import type { SynchConflictFile } from "../contracts";
import type { ConflictPreviewModalOptions } from "./conflict-preview-modal";
import { openConfirmModal } from "../modals/confirm-modal";
import { SynchConflictView, type ConflictViewController } from "./conflict-view";

const { showComparison } = vi.hoisted(() => ({ showComparison: vi.fn() }));
vi.mock("./conflict-preview-modal", () => ({
  ConflictPreviewModal: class {
    constructor(_app: unknown, options: ConflictPreviewModalOptions) {
      showComparison(options);
    }
    open() {}
  },
}));
vi.mock("../modals/confirm-modal", () => ({ openConfirmModal: vi.fn() }));

const conflict: SynchConflictFile = {
  originalPath: "note.md",
  copyPath: "note.sync-conflict-20260424-001419.md",
  originalExists: true,
  originalSize: 4,
  copySize: 9,
  modifiedAt: 2,
};

// Access UI handlers without needing a browser DOM in the Obsidian test stub.
type ViewHandlers = {
  render(): void;
  openPreview(conflict: SynchConflictFile): Promise<void>;
  renderRow(container: HTMLElement, conflict: SynchConflictFile): void;
  addButton(container: HTMLElement, label: string, onClick: () => void | Promise<void>, primary?: boolean): HTMLButtonElement;
};

function fixture() {
  const displayed = {
    original: "one\n", copy: "one\ncopy\n", merged: "one\ncopy\n",
    originalFile: { path: "note.md", bytes: new TextEncoder().encode("one\n") },
    copyFile: { path: conflict.copyPath, bytes: new TextEncoder().encode("one\ncopy\n") },
  };
  const controller: ConflictViewController = {
    listConflicts: vi.fn(async () => [conflict]),
    previewConflict: vi.fn(async () => displayed),
    resolveConflict: vi.fn(async () => {}),
    hideConflict: vi.fn(),
  };
  const view = new SynchConflictView({} as WorkspaceLeaf, controller);
  const handlers = view as unknown as ViewHandlers;
  vi.spyOn(handlers, "render").mockImplementation(() => {});
  vi.spyOn(view, "refresh").mockResolvedValue(undefined);
  return { displayed, controller, view, handlers };
}

describe("SynchConflictView merge confirmation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(["keep-original", "keep-copy", "merge"] as const)("passes the exact displayed snapshot through confirmation for %s", async (action) => {
    const { displayed, controller, handlers } = fixture();
    let confirm!: (accepted: boolean) => void;
    vi.mocked(openConfirmModal).mockReturnValueOnce(
      new Promise<boolean>((resolve) => { confirm = resolve; }),
    );

    await handlers.openPreview(conflict);
    const options = showComparison.mock.calls[0][0] as ConflictPreviewModalOptions;
    expect(options.preview).toBe(displayed);
    options.onChoose(action);
    expect(controller.resolveConflict).not.toHaveBeenCalled();
    // A later preview must not replace what the user saw while confirming.
    vi.mocked(controller.previewConflict).mockResolvedValue({
      ...displayed, original: "other\n", copy: "other\ncopy\n", merged: "other\ncopy\n",
    });
    confirm(true);

    await vi.waitFor(() => expect(controller.resolveConflict).toHaveBeenCalledOnce());
    expect(controller.resolveConflict).toHaveBeenCalledWith(conflict.copyPath, action, displayed);
    expect(vi.mocked(controller.resolveConflict).mock.calls[0][2]).toBe(displayed);
    expect(controller.previewConflict).toHaveBeenCalledOnce();
  });

  it("opens the comparison from the list without preloading file contents", async () => {
    const { controller, view, handlers } = fixture();
    const openPreview = vi.spyOn(handlers, "openPreview").mockResolvedValue(undefined);
    const addButton = vi.spyOn(handlers, "addButton").mockReturnValue({
      setAttribute: vi.fn(),
    } as unknown as HTMLButtonElement);

    handlers.renderRow(view.contentEl, conflict);
    await addButton.mock.calls[0][2]();

    expect(addButton).toHaveBeenCalledOnce();
    expect(openPreview).toHaveBeenCalledWith(conflict);
    expect(controller.previewConflict).not.toHaveBeenCalled();
    expect(controller.resolveConflict).not.toHaveBeenCalled();
  });
});


describe("conflict list refresh scheduling", () => {
  afterEach(() => { vi.useRealTimers(); });

  function refreshFixture() {
    const result = fixture();
    vi.mocked(result.view.refresh).mockRestore();
    return result;
  }

  it("coalesces a burst of relevant events and ignores unrelated edits", async () => {
    vi.useFakeTimers();
    const { controller, view } = refreshFixture();
    await view.refresh();
    vi.mocked(controller.listConflicts).mockClear();
    view.queueRefresh(["unrelated.md"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.listConflicts).not.toHaveBeenCalled();
    for (let i = 0; i < 100; i++) view.queueRefresh([conflict.originalPath]);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.listConflicts).toHaveBeenCalledOnce();
    expect(controller.previewConflict).not.toHaveBeenCalled();
  });

  it("refreshes for newly created copies, old rename paths, and folders", async () => {
    vi.useFakeTimers();
    const { controller, view } = refreshFixture();
    await view.refresh();
    for (const paths of [["new.sync-conflict-20261029-121000.md"], ["moved.md", conflict.originalPath], undefined]) {
      vi.mocked(controller.listConflicts).mockClear();
      view.queueRefresh(paths);
      await vi.advanceTimersByTimeAsync(100);
      expect(controller.listConflicts).toHaveBeenCalledOnce();
    }
  });

  it("cancels queued work when the pane closes", async () => {
    vi.useFakeTimers();
    const { controller, view } = refreshFixture();
    view.queueRefresh();
    await view.onClose();
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.listConflicts).not.toHaveBeenCalled();
  });

  it("does not publish a stale refresh after the pane closes", async () => {
    const { controller, view, handlers } = refreshFixture();
    let complete!: (files: typeof conflict[]) => void;
    vi.mocked(controller.listConflicts).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const pending = view.refresh();
    vi.mocked(handlers.render).mockClear();
    await view.onClose();
    complete([conflict]);
    await pending;
    expect(handlers.render).not.toHaveBeenCalled();
  });
});
