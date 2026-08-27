import { describe, expect, it } from "vitest";

import {
  colorForPresenceId,
  peersOnPath,
  presencePeerFromSelection,
  presencePeerLabel,
} from "./presence-codec";

describe("presence codec", () => {
  it("labels peers by display name and falls back to Anonymous", () => {
    expect(
      presencePeerLabel(
        { displayName: "Ada" },
      ),
    ).toBe("Ada");
    expect(
      presencePeerLabel(
        { displayName: "  " },
      ),
    ).toBe("Anonymous");
  });

  it("matches roster entries by locally resolved path", () => {
    const peer = presencePeerFromSelection(
      {
        presenceId: "peer-1",
        entryId: "entry-1",
        userId: "ada",
        displayName: "Ada",
      },
      {
        anchor: { line: 3, ch: 0 },
        head: { line: 3, ch: 0 },
      },
      "Notes/a.md",
    );

    expect(peersOnPath([peer], "Notes/a.md")).toHaveLength(1);
    expect(peersOnPath([peer], "Notes/missing.md")).toHaveLength(0);
  });

  it("keeps a stable color per presence id", () => {
    expect(colorForPresenceId("peer-1")).toBe(colorForPresenceId("peer-1"));
    expect(colorForPresenceId("peer-1")).not.toBe(colorForPresenceId("peer-2"));
  });

});
