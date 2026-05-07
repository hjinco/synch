import { describe, expect, it } from "vitest";

import { findCoveringParent } from "./modals";

const sortByDepthAsc = (folders: string[]): string[] =>
  [...folders].sort((left, right) => left.length - right.length);

describe("findCoveringParent", () => {
  it("returns null when no other folder covers the input", () => {
    expect(findCoveringParent("Foo", sortByDepthAsc(["Bar", "Baz"]))).toBeNull();
  });

  it("returns the covering ancestor when one is selected", () => {
    expect(findCoveringParent("Foo/Bar", sortByDepthAsc(["Foo"]))).toBe("Foo");
  });

  it("does not treat a folder as its own parent", () => {
    expect(findCoveringParent("Foo", sortByDepthAsc(["Foo"]))).toBeNull();
  });

  it("does not treat lookalike siblings as ancestors", () => {
    expect(findCoveringParent("Foobar", sortByDepthAsc(["Foo"]))).toBeNull();
  });

  it("finds the ancestor across multiple selected entries", () => {
    expect(
      findCoveringParent("Foo/Sub/Deep", sortByDepthAsc(["Bar", "Foo", "Baz"])),
    ).toBe("Foo");
  });

  it("returns the topmost ancestor when several ancestors are selected", () => {
    expect(
      findCoveringParent("Foo/Bar/Baz", sortByDepthAsc(["Foo/Bar", "Foo"])),
    ).toBe("Foo");
  });

  it("returns the ancestor even when the input itself is selected", () => {
    expect(
      findCoveringParent("Foo/Bar", sortByDepthAsc(["Foo", "Foo/Bar"])),
    ).toBe("Foo");
  });
});
