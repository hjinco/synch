import { beforeEach, describe, expect, it, vi } from "vitest";
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
  mergeablePaths: Set<string>;
  addButton(container: HTMLElement, label: string, onClick: () => void | Promise<void>, primary?: boolean): HTMLButtonElement;
};

function fixture() {
  const displayed = { original: "one\n", copy: "one\ncopy\n", merged: "one\ncopy\n" };
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

  it("passes the exact displayed snapshot through confirmation to resolution", async () => {
    const { displayed, controller, handlers } = fixture();
    let confirm!: (accepted: boolean) => void;
    vi.mocked(openConfirmModal).mockReturnValueOnce(
      new Promise<boolean>((resolve) => { confirm = resolve; }),
    );

    await handlers.openPreview(conflict);
    const options = showComparison.mock.calls[0][0] as ConflictPreviewModalOptions;
    expect(options.preview).toBe(displayed);
    options.onChoose("merge");
    expect(controller.resolveConflict).not.toHaveBeenCalled();
    // A later preview must not replace what the user saw while confirming.
    vi.mocked(controller.previewConflict).mockResolvedValue({
      original: "other\n", copy: "other\ncopy\n", merged: "other\ncopy\n",
    });
    confirm(true);

    await vi.waitFor(() => expect(controller.resolveConflict).toHaveBeenCalledOnce());
    expect(controller.resolveConflict).toHaveBeenCalledWith(conflict.copyPath, "merge", displayed);
    expect(vi.mocked(controller.resolveConflict).mock.calls[0][2]).toBe(displayed);
    expect(controller.previewConflict).toHaveBeenCalledOnce();
  });

  it("opens the comparison for the list's merge button instead of bypassing inspection", async () => {
    const { controller, view, handlers } = fixture();
    handlers.mergeablePaths.add(conflict.copyPath);
    const openPreview = vi.spyOn(handlers, "openPreview").mockResolvedValue(undefined);
    const addButton = vi.spyOn(handlers, "addButton").mockReturnValue({
      setAttribute: vi.fn(),
    } as unknown as HTMLButtonElement);

    handlers.renderRow(view.contentEl, conflict);
    await addButton.mock.calls[0][2]();

    expect(openPreview).toHaveBeenCalledWith(conflict);
    expect(controller.resolveConflict).not.toHaveBeenCalled();
  });
});
