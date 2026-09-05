import { describe, expect, it } from "vitest";

import { formatSyncProgressSuffix } from "./notices";

describe("formatSyncProgressSuffix", () => {
  it("does not render an unknown total as a denominator", () => {
    const suffix = formatSyncProgressSuffix({
      completedEntries: 100,
      totalEntries: 100,
      direction: "push",
      totalKnown: false,
    });

    expect(suffix).toContain("100");
    expect(suffix).not.toContain("/");
  });

  it("renders the denominator after the total becomes known", () => {
    const suffix = formatSyncProgressSuffix({
      completedEntries: 100,
      totalEntries: 232,
      direction: "push",
      totalKnown: true,
    });

    expect(suffix).toContain("100/232");
  });

  it("omits progress when there are no entries", () => {
    expect(
      formatSyncProgressSuffix({
        completedEntries: 0,
        totalEntries: 0,
        direction: "push",
        totalKnown: true,
      }),
    ).toBe("");
  });
});
