import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  buildRemotePresenceSelectionDecorations,
  type RemotePresenceSelection,
} from "./presence-editor";

describe("presence editor selections", () => {
  it("decorates the selected range regardless of selection direction", () => {
    const doc = Text.of(["alpha", "bravo", "charlie"]);
    const selections: RemotePresenceSelection[] = [
      {
        presenceId: "peer-1",
        color: "hsl(120 70% 45% / 0.2)",
        selection: {
          anchor: { line: 2, ch: 3 },
          head: { line: 1, ch: 2 },
        },
      },
    ];

    const cursor = buildRemotePresenceSelectionDecorations(doc, selections).iter();
    expect(cursor).toMatchObject({
      from: 8,
      to: 15,
      value: {
        spec: {
          class: "synch-presence-selection",
          attributes: {
            style: "background-color: hsl(120 70% 45% / 0.2);",
          },
        },
      },
    });
  });

  it("does not add a range decoration for a caret or invalid position", () => {
    const doc = Text.of(["alpha"]);
    const selections: RemotePresenceSelection[] = [
      {
        presenceId: "caret",
        color: "hsl(120 70% 45% / 0.2)",
        selection: {
          anchor: { line: 0, ch: 2 },
          head: { line: 0, ch: 2 },
        },
      },
      {
        presenceId: "invalid",
        color: "hsl(200 70% 45% / 0.2)",
        selection: {
          anchor: { line: 0, ch: 2 },
          head: { line: 3, ch: 0 },
        },
      },
    ];

    expect(buildRemotePresenceSelectionDecorations(doc, selections).size).toBe(0);
  });
});
