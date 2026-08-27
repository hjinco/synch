import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import type {
  PresencePosition,
  PresenceSelection,
} from "@synch/sync-client/sync/core/presence";

export type RemotePresenceCaret = {
  presenceId: string;
  label: string;
  color: string;
  line: number;
  ch: number;
};

export type RemotePresenceSelection = {
  presenceId: string;
  color: string;
  selection: PresenceSelection;
};

const setRemotePresenceCarets = StateEffect.define<RemotePresenceCaret[]>();
const setRemotePresenceSelections = StateEffect.define<RemotePresenceSelection[]>();

class PresenceCaretWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly color: string,
  ) {
    super();
  }

  eq(other: PresenceCaretWidget): boolean {
    return this.label === other.label && this.color === other.color;
  }

  toDOM(): HTMLElement {
    const caret = createWidgetSpan("synch-presence-caret");
    caret.style.borderLeftColor = this.color;
    const tag = createWidgetSpan("synch-presence-caret-label");
    tag.textContent = this.label;
    tag.style.backgroundColor = this.color;
    caret.appendChild(tag);
    return caret;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const caretsField = StateField.define<RemotePresenceCaret[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRemotePresenceCarets)) {
        return effect.value;
      }
    }
    return value;
  },
});

const caretDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, transaction) {
    return buildCaretDecorations(
      transaction.state.doc,
      transaction.state.field(caretsField),
    );
  },
  provide: (field) => EditorView.decorations.from(field as never),
});

const selectionsField = StateField.define<RemotePresenceSelection[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRemotePresenceSelections)) {
        return effect.value;
      }
    }
    return value;
  },
});

const selectionDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, transaction) {
    return buildSelectionDecorations(
      transaction.state.doc,
      transaction.state.field(selectionsField),
    );
  },
  provide: (field) => EditorView.decorations.from(field as never),
});

const synchPresenceEditorExtension: Extension = [
  caretsField,
  caretDecorations,
  selectionsField,
  selectionDecorations,
];

export function createSynchPresenceEditorExtension(onUpdate: () => void): Extension {
  return [
    synchPresenceEditorExtension,
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.focusChanged) {
        onUpdate();
      }
    }),
  ];
}

export function getMarkdownEditorView(view: {
  editor?: { cm?: unknown };
}): EditorView | null {
  const editorView = view.editor?.cm;
  if (!editorView || typeof editorView !== "object") {
    return null;
  }
  return editorView as EditorView;
}

function createWidgetSpan(className: string): HTMLSpanElement {
  const body = document.body as HTMLElement & {
    createSpan?: (options: { cls: string }) => HTMLSpanElement;
  };
  if (!body.createSpan) {
    throw new Error("Cannot create presence caret element");
  }
  return body.createSpan({ cls: className });
}

export function applyRemotePresence(
  view: EditorView,
  carets: RemotePresenceCaret[],
  selections: RemotePresenceSelection[],
): void {
  view.dispatch({
    effects: [
      setRemotePresenceCarets.of(carets),
      setRemotePresenceSelections.of(selections),
    ],
  });
}

function buildCaretDecorations(doc: Text, carets: RemotePresenceCaret[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const items: Array<{ from: number; deco: Decoration }> = [];

  for (const caret of carets) {
    const pos = positionToOffset(doc, {
      line: caret.line,
      ch: caret.ch,
    });
    if (pos === null) {
      continue;
    }
    items.push({
      from: pos,
      deco: Decoration.widget({
        widget: new PresenceCaretWidget(caret.label, caret.color),
        side: 1,
      }),
    });
  }

  items.sort((left, right) => left.from - right.from);
  for (const item of items) {
    builder.add(item.from, item.from, item.deco);
  }
  return builder.finish() as DecorationSet;
}

export function buildRemotePresenceSelectionDecorations(
  doc: Text,
  selections: RemotePresenceSelection[],
): DecorationSet {
  return buildSelectionDecorations(doc, selections);
}

function buildSelectionDecorations(
  doc: Text,
  selections: RemotePresenceSelection[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const items: Array<{ from: number; to: number; deco: Decoration }> = [];

  for (const remote of selections) {
    const anchor = positionToOffset(doc, remote.selection.anchor);
    const head = positionToOffset(doc, remote.selection.head);
    if (anchor === null || head === null || anchor === head) {
      continue;
    }

    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    items.push({
      from,
      to,
      deco: Decoration.mark({
        class: "synch-presence-selection",
        attributes: {
          style: `background-color: ${remote.color};`,
        },
      }),
    });
  }

  items.sort((left, right) => left.from - right.from || left.to - right.to);
  for (const item of items) {
    builder.add(item.from, item.to, item.deco);
  }
  return builder.finish() as DecorationSet;
}

function positionToOffset(doc: Text, position: PresencePosition): number | null {
  if (
    !Number.isInteger(position.line) ||
    position.line < 0 ||
    position.line >= doc.lines ||
    !Number.isInteger(position.ch)
  ) {
    return null;
  }

  const line = doc.line(position.line + 1);
  return Math.min(line.from + Math.max(0, position.ch), line.to);
}
