import { describe, expect, it } from "vitest";

import { parseSyncedEntryMetadata } from "../../../core/content";

describe("parseSyncedEntryMetadata", () => {
  it("parses metadata with a hash", () => {
    expect(
      parseSyncedEntryMetadata(JSON.stringify({ path: "Folder/file.md", hash: "hash-1" })),
    ).toEqual({
      path: "Folder/file.md",
      hash: "hash-1",
    });
  });

  it("rejects metadata without a hash", () => {
    expect(() => parseSyncedEntryMetadata(JSON.stringify({ path: "Folder/file.md" }))).toThrow(
      "missing a hash",
    );
  });
});
