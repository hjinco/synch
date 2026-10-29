import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

import { getCreatedElements, getCreatedElementTexts, resetObsidianMocks } from "../../test-stubs/obsidian";
import { ConflictPreviewModal } from "./conflict-preview-modal";
import type { SynchConflictFile } from "../contracts";
import type { ConflictPreview } from "./conflict-preview";

const conflict: SynchConflictFile = {
  originalPath: "note.md", copyPath: "note.sync-conflict-20260424-001419.md",
  originalExists: true, originalSize: 4, copySize: 9, modifiedAt: 2,
};

function preview(original: string | null, copy: string): ConflictPreview {
  return {
    original, copy, merged: null,
    originalFile: original === null ? null : { path: conflict.originalPath, bytes: new TextEncoder().encode(original) },
    copyFile: { path: conflict.copyPath, bytes: new TextEncoder().encode(copy) },
  };
}

function openModal(displayed: ConflictPreview, entry = conflict) {
  const vault = { readBinary: vi.fn(), getResourcePath: vi.fn() };
  const modal = new ConflictPreviewModal({ vault } as unknown as App, {
    conflict: entry, preview: displayed, onChoose: vi.fn(),
  });
  modal.onOpen();
  return { modal, vault };
}

describe("conflict comparison snapshots", () => {
  beforeEach(() => { resetObsidianMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("uses captured missing-original contents and availability, even if list metadata is stale", () => {
    const { modal, vault } = openModal(preview(null, "captured copy\n"));
    expect(getCreatedElementTexts()).toContain("captured copy\n");
    const buttons = getCreatedElements().filter((element) => element.tag === "button").map((element) => element.text);
    expect(buttons).toEqual(["Keep copy"]);
    expect(vault.readBinary).not.toHaveBeenCalled();
    modal.onClose();
  });

  it("renders images from captured bytes and releases their URLs on close", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:original").mockReturnValueOnce("blob:copy");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const displayed = preview("<svg>original</svg>", "<svg>copy</svg>");
    displayed.originalFile!.path = "drawing.svg";
    displayed.copyFile.path = "drawing.sync-conflict-20260424-001419.svg";
    const { modal, vault } = openModal(displayed, {
      ...conflict, originalPath: displayed.originalFile!.path, copyPath: displayed.copyFile.path,
    });
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(getCreatedElements().filter((element) => element.tag === "img")).toHaveLength(2);
    const originalBlob = createUrl.mock.calls[0]![0] as Blob;
    expect(originalBlob.type).toBe("image/svg+xml");
    expect(await originalBlob.text()).toBe("<svg>original</svg>");
    expect(vault.getResourcePath).not.toHaveBeenCalled();
    expect(vault.readBinary).not.toHaveBeenCalled();
    modal.onClose();
    expect(revokeUrl.mock.calls).toEqual([["blob:original"], ["blob:copy"]]);
  });

  it("offers merge only for the captured mergeable pair", () => {
    const displayed = preview("one\n", "one\ncopy\n");
    displayed.merged = displayed.copy;
    const { modal } = openModal(displayed);
    expect(getCreatedElements().filter((element) => element.tag === "button").map((element) => element.text))
      .toEqual(["Keep original", "Keep copy", "Merge automatically"]);
    modal.onClose();
  });
});
