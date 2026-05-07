import { describe, expect, it } from "vitest";

import { findCoveringParent } from "./modals";

describe("findCoveringParent", () => {
  it("returns null when no other folder covers the input", () => {
    const selected = new Set(["Bar", "Baz"]);
    expect(findCoveringParent("Foo", selected)).toBeNull();
  });

  it("returns the covering ancestor when one is selected", () => {
    const selected = new Set(["Foo"]);
    expect(findCoveringParent("Foo/Bar", selected)).toBe("Foo");
  });

  it("does not treat a folder as its own parent", () => {
    const selected = new Set(["Foo"]);
    expect(findCoveringParent("Foo", selected)).toBeNull();
  });

  it("does not treat lookalike siblings as ancestors", () => {
    const selected = new Set(["Foo"]);
    expect(findCoveringParent("Foobar", selected)).toBeNull();
  });

  it("finds the ancestor across multiple selected entries", () => {
    const selected = new Set(["Bar", "Foo", "Baz"]);
    expect(findCoveringParent("Foo/Sub/Deep", selected)).toBe("Foo");
  });

  it("returns the topmost ancestor when several ancestors are selected", () => {
    const selected = new Set(["Foo/Bar", "Foo"]);
    expect(findCoveringParent("Foo/Bar/Baz", selected)).toBe("Foo");
  });

  it("returns the ancestor even when the input itself is selected", () => {
    const selected = new Set(["Foo", "Foo/Bar"]);
    expect(findCoveringParent("Foo/Bar", selected)).toBe("Foo");
  });
});
