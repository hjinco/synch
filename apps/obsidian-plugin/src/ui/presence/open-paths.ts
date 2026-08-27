import type {
  PresencePosition,
  PresenceSelection,
} from "@synch/sync-client/sync/core/presence";
import { getMarkdownEditorView } from "./presence-editor";

export type PresenceWorkspaceLeaf = {
  view: MarkdownPresenceView;
};

export type MarkdownPresenceView = {
  getMode?: () => string;
  file?: { path: string } | null;
  editor?: {
    cm?: unknown;
  };
  containerEl: HTMLElement;
  contentEl: HTMLElement;
};

export type PresenceWorkspace = {
  getLeavesOfType(type: string): PresenceWorkspaceLeaf[];
  activeLeaf: unknown;
};

export function collectOpenMarkdownPresencePaths(
  workspace: PresenceWorkspace,
): string[] {
  const leaves = workspace.getLeavesOfType("markdown");
  const activeLeaf = leaves.find((leaf) => leaf === workspace.activeLeaf);
  const orderedLeaves = activeLeaf
    ? [activeLeaf, ...leaves.filter((leaf) => leaf !== activeLeaf)]
    : leaves;
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const leaf of orderedLeaves) {
    const path = leaf.view.file?.path?.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }

  return paths;
}

export type ActiveMarkdownPresence = {
  path: string;
  selection: PresenceSelection;
};

export function collectActiveMarkdownPresenceFile(
  workspace: PresenceWorkspace,
): ActiveMarkdownPresence | null {
  for (const leaf of workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    const path = view.file?.path?.trim();
    if (!path) {
      continue;
    }
    if (leaf !== workspace.activeLeaf || view.getMode?.() !== "source") {
      continue;
    }
    if (!hasEditorFocus(view)) {
      continue;
    }

    const selection = getEditorSelection(view);
    if (!selection) {
      continue;
    }

    return {
      path,
      selection,
    };
  }
  return null;
}

function hasEditorFocus(view: MarkdownPresenceView): boolean {
  return getMarkdownEditorView(view)?.hasFocus === true;
}

function getEditorSelection(view: MarkdownPresenceView): PresenceSelection | null {
  const editorView = getMarkdownEditorView(view);
  if (!editorView) {
    return null;
  }
  const main = editorView.state.selection.main;
  return {
    anchor: positionAt(editorView.state.doc, main.anchor),
    head: positionAt(editorView.state.doc, main.head),
  };
}

function positionAt(
  doc: { lineAt(position: number): { number: number; from: number } },
  offset: number,
): PresencePosition {
  const line = doc.lineAt(offset);
  return {
    line: line.number - 1,
    ch: offset - line.from,
  };
}
