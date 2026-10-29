import { describe, expect, it } from "vitest";

import { findConflictFiles, type ConflictVaultFile } from "./conflict-files";

function file(path: string, size = 10, mtime = 1_000): ConflictVaultFile {
  return { path, stat: { size, mtime } };
}

describe("findConflictFiles", () => {
  it("pairs a conflict copy with its original", () => {
    const conflicts = findConflictFiles([
      file("Notes/note.md", 100),
      file("Notes/note.sync-conflict-20260424-001419.md", 200),
    ]);

    expect(conflicts).toEqual([
      {
        copyPath: "Notes/note.sync-conflict-20260424-001419.md",
        originalPath: "Notes/note.md",
        copySize: 200,
        originalSize: 100,
        originalExists: true,
        modifiedAt: 1_000,
      },
    ]);
  });

  it("ignores files that are not conflict copies", () => {
    expect(
      findConflictFiles([file("a.md"), file("b.md"), file("folder/c.md")]),
    ).toEqual([]);
  });

  it("reports a missing original instead of assuming it exists", () => {
    const [conflict] = findConflictFiles([
      file("Notes/note.sync-conflict-20260424-001419.md"),
    ]);

    expect(conflict?.originalExists).toBe(false);
    expect(conflict?.originalSize).toBeNull();
    expect(conflict?.originalPath).toBe("Notes/note.md");
  });

  it("handles retry-suffixed copies from repeated conflicts", () => {
    const conflicts = findConflictFiles([
      file("note.md"),
      file("note.sync-conflict-20260424-001419.md"),
      file("note.sync-conflict-20260424-001419-2.md"),
    ]);

    // Equal mtimes fall back to path order, which puts the "-2" retry first.
    expect(conflicts.map((conflict) => conflict.copyPath)).toEqual([
      "note.sync-conflict-20260424-001419-2.md",
      "note.sync-conflict-20260424-001419.md",
    ]);
    expect(conflicts.every((conflict) => conflict.originalPath === "note.md")).toBe(true);
  });

  it("sorts newest first, then by path", () => {
    const conflicts = findConflictFiles([
      file("old.sync-conflict-20260424-001419.md", 10, 1_000),
      file("new.sync-conflict-20260424-001420.md", 10, 3_000),
      file("tie.sync-conflict-20260424-001421.md", 10, 3_000),
    ]);

    expect(conflicts.map((conflict) => conflict.copyPath)).toEqual([
      "new.sync-conflict-20260424-001420.md",
      "tie.sync-conflict-20260424-001421.md",
      "old.sync-conflict-20260424-001419.md",
    ]);
  });

  it("pairs nested paths and dotted stems correctly", () => {
    const conflicts = findConflictFiles([
      file("a/b/my.note.md", 5),
      file("a/b/my.note.sync-conflict-20260424-001419.md", 6),
    ]);

    expect(conflicts[0]?.originalPath).toBe("a/b/my.note.md");
  });

  it("does not treat an unrelated file's conflict copy as its own original", () => {
    // A copy whose original is a *different* file must pair with that file,
    // not with whatever else happens to exist.
    const conflicts = findConflictFiles([
      file("other.md", 1),
      file("note.sync-conflict-20260424-001419.md", 2),
    ]);

    expect(conflicts[0]?.originalPath).toBe("note.md");
    expect(conflicts[0]?.originalExists).toBe(false);
  });

  it("finds multiple conflicts in one run", () => {
    const conflicts = findConflictFiles([
      file("a.md"),
      file("a.sync-conflict-20260424-001419.md", 10, 2_000),
      file("b.md"),
      file("b.sync-conflict-20260424-001420.md", 20, 1_000),
    ]);

    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((conflict) => conflict.originalPath)).toEqual(["a.md", "b.md"]);
  });
});