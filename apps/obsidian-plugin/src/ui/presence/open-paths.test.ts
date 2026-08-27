import { describe, expect, it } from "vitest";

import {
  collectActiveMarkdownPresenceFile,
  collectOpenMarkdownPresencePaths,
  type PresenceWorkspace,
} from "./open-paths";

describe("open markdown presence paths", () => {
  it("returns the focused active source editor", () => {
    const workspace = createWorkspace([
      {
        path: "Active.md",
        mode: "source",
        active: true,
        focused: true,
        line: 2,
        ch: 4,
      },
      {
        path: "Reading.md",
        mode: "preview",
        active: false,
        focused: false,
        content: "reading",
      },
    ]);

    expect(collectActiveMarkdownPresenceFile(workspace)).toEqual({
      path: "Active.md",
      selection: {
        anchor: { line: 2, ch: 4 },
        head: { line: 2, ch: 4 },
      },
    });
  });

  it("returns the complete main selection", () => {
    const workspace = createWorkspace([
      {
        path: "Selected.md",
        mode: "source",
        active: true,
        focused: true,
        anchor: { line: 1, ch: 2 },
        head: { line: 3, ch: 5 },
      },
    ]);

    expect(collectActiveMarkdownPresenceFile(workspace)).toEqual({
      path: "Selected.md",
      selection: {
        anchor: { line: 1, ch: 2 },
        head: { line: 3, ch: 5 },
      },
    });
  });

  it("returns all open markdown paths with the active path first", () => {
    const workspace = createWorkspace([
      {
        path: "Other.md",
        mode: "source",
        active: false,
        focused: false,
      },
      {
        path: "Active.md",
        mode: "source",
        active: true,
        focused: true,
      },
      {
        path: "Other.md",
        mode: "preview",
        active: false,
        focused: false,
      },
    ]);

    expect(collectOpenMarkdownPresencePaths(workspace)).toEqual([
      "Active.md",
      "Other.md",
    ]);
  });

  it("does not return an inactive source split", () => {
    const workspace = createWorkspace([
      {
        path: "Split.md",
        mode: "source",
        active: false,
        focused: true,
        line: 8,
        ch: 2,
      },
    ]);

    expect(collectActiveMarkdownPresenceFile(workspace)).toBeNull();
  });

  it("does not return preview or an unfocused source editor", () => {
    const workspace = createWorkspace([
      {
        path: "Preview.md",
        mode: "preview",
        active: true,
        focused: false,
        line: 0,
        ch: 1,
      },
    ]);

    expect(collectActiveMarkdownPresenceFile(workspace)).toBeNull();

    const unfocusedSource = createWorkspace([
      {
        path: "Unfocused.md",
        mode: "source",
        active: true,
        focused: false,
        line: 0,
        ch: 1,
      },
    ]);

    expect(collectActiveMarkdownPresenceFile(unfocusedSource)).toBeNull();
  });
});

function createWorkspace(
  leaves: Array<{
    path: string;
    mode: "source" | "preview";
    active: boolean;
    focused: boolean;
    line?: number;
    ch?: number;
    anchor?: { line: number; ch: number };
    head?: { line: number; ch: number };
  }>,
): PresenceWorkspace {
  const workspaceLeaves = leaves.map((leaf) => ({
    view: {
      getMode: () => leaf.mode,
      file: { path: leaf.path },
      editor: {
        cm: {
          hasFocus: leaf.focused,
          state: {
            selection: {
              main: {
                anchor: selectionOffset(leaf.anchor ?? cursorPosition(leaf)),
                head: selectionOffset(leaf.head ?? cursorPosition(leaf)),
              },
            },
            doc: {
              lineAt(offset: number) {
                const line = Math.floor(offset / 1_000);
                return { number: line + 1, from: line * 1_000 };
              },
            },
          },
        },
      },
      containerEl: {} as HTMLElement,
      contentEl: {} as HTMLElement,
    },
  }));
  return {
    getLeavesOfType: () => workspaceLeaves,
    activeLeaf: workspaceLeaves.find((_, index) => leaves[index]?.active) ?? null,
  };
}

function cursorPosition(leaf: { line?: number; ch?: number }): { line: number; ch: number } {
  return { line: leaf.line ?? 0, ch: leaf.ch ?? 0 };
}

function selectionOffset(position: { line: number; ch: number }): number {
  return position.line * 1_000 + position.ch;
}
