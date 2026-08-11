import { describe, expect, it } from "vitest";

import { mergeText3 } from "./text-merge";
import { isAutoMergeTextPath } from "./text-merge-policy";

describe("mergeText3", () => {
  it("merges independent line edits", () => {
    expect(
      mergeText3(
        "Title\n\noriginal line\n",
        "Title\n\nlocal line\n",
        "Remote title\n\noriginal line\n",
      ),
    ).toEqual({
      status: "clean",
      text: "Remote title\n\nlocal line\n",
    });
  });

  it("reports overlapping edits as conflicts", () => {
    expect(mergeText3("one\n", "local\n", "remote\n")).toEqual({
      status: "conflict",
    });
  });

  it("does not attempt automatic merge when the LCS budget would exceed 2M cells", () => {
    const base = numberedLines(2_000);
    const local = `${base}local\n`;
    const remote = `remote\n${base}`;

    expect(mergeText3(base, local, remote)).toEqual({
      status: "conflict",
    });
  });

  it("keeps exact-match fast paths for line-dense inputs", () => {
    const text = numberedLines(10_001);

    expect(mergeText3("base\n", text, text)).toEqual({
      status: "clean",
      text,
    });
  });
});

describe("isAutoMergeTextPath", () => {
  it("allows mergeable text extensions case-insensitively", () => {
    expect(isAutoMergeTextPath("Folder/note.md")).toBe(true);
    expect(isAutoMergeTextPath("Folder/note.MD")).toBe(true);
  });

  it("rejects unsupported or extensionless paths", () => {
    expect(isAutoMergeTextPath("Folder/image.png")).toBe(false);
    expect(isAutoMergeTextPath("Folder/README")).toBe(false);
  });
});

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}\n`).join("");
}
