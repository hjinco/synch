import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  getConflictOriginalPath,
  isImagePath,
  normalizeExcludedFolders,
  normalizeIncludedHiddenFolders,
  normalizeSyncFileRules,
  shouldSyncPath,
} from "./file-rules";

describe("shouldSyncPath", () => {
  it("always syncs markdown files outside hidden folders", () => {
    expect(shouldSyncPath("Notes/daily.md", DEFAULT_SYNC_FILE_RULES)).toBe(true);
  });

  it("excludes hidden paths and folders", () => {
    expect(shouldSyncPath(".obsidian/workspace.json", DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", DEFAULT_SYNC_FILE_RULES)).toBe(false);
  });

  it("syncs allowlisted hidden folders while keeping reserved paths blocked", () => {
    const rules = normalizeSyncFileRules(
      {
        ...DEFAULT_SYNC_FILE_RULES,
        includeOtherFiles: true,
        includedHiddenFolders: [".assets", "Notes/.attachments"],
      },
      ".obsidian",
    );

    expect(shouldSyncPath(".assets/image.png", rules, ".obsidian")).toBe(true);
    expect(shouldSyncPath("Notes/.attachments/data.json", rules, ".obsidian")).toBe(
      true,
    );
    expect(shouldSyncPath(".unlisted/file.md", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/app.json", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".git/config", rules, ".obsidian")).toBe(false);
  });

  it("excludes Obsidian configuration files even when other files are enabled", () => {
    const rules = normalizeSyncFileRules(
      {
        ...DEFAULT_SYNC_FILE_RULES,
        includeOtherFiles: true,
      },
      ".obsidian",
    );

    expect(shouldSyncPath(".obsidian/app.json", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace.json", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/snippets/tweaks.css", rules, ".obsidian")).toBe(
      false,
    );
    expect(
      shouldSyncPath(".obsidian/plugins/calendar/data.json", rules, ".obsidian"),
    ).toBe(false);
    expect(shouldSyncPath(".git/config", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", rules, ".obsidian")).toBe(false);
  });

  it("does not sync the active config folder through included hidden folders", () => {
    const rules = normalizeSyncFileRules(
      {
        ...DEFAULT_SYNC_FILE_RULES,
        includeOtherFiles: true,
        includedHiddenFolders: [".obsidian", ".assets"],
      },
      ".obsidian",
    );

    expect(rules.includedHiddenFolders).toEqual([".assets"]);
    expect(shouldSyncPath(".obsidian/app.json", rules, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace.json", rules, ".obsidian")).toBe(false);
    expect(
      shouldSyncPath(".obsidian/plugins/synch/data.json", rules, ".obsidian"),
    ).toBe(false);
    expect(shouldSyncPath(".assets/image.png", rules, ".obsidian")).toBe(true);
  });

  it("can sync an inactive config folder when it is explicitly included", () => {
    const rules = normalizeSyncFileRules(
      {
        ...DEFAULT_SYNC_FILE_RULES,
        includeOtherFiles: true,
        includedHiddenFolders: [".obsidian"],
      },
      ".obsidian-mobile",
    );

    expect(rules.includedHiddenFolders).toEqual([".obsidian"]);
    expect(shouldSyncPath(".obsidian/app.json", rules, ".obsidian-mobile")).toBe(true);
    expect(
      shouldSyncPath(".obsidian-mobile/app.json", rules, ".obsidian-mobile"),
    ).toBe(false);
  });

  it("excludes generated sync conflict copies", () => {
    expect(shouldSyncPath("Welcomed.sync-conflict-20260424-001419.md", DEFAULT_SYNC_FILE_RULES)).toBe(
      false,
    );
    expect(
      shouldSyncPath("Folder/note.sync-conflict-20260424-001419-2.md", DEFAULT_SYNC_FILE_RULES),
    ).toBe(false);
    expect(
      shouldSyncPath(
        ".obsidian/plugins/calendar/data.sync-conflict-20260424-001419.json",
        DEFAULT_SYNC_FILE_RULES,
      ),
    ).toBe(false);
  });

  it("respects attachment category toggles", () => {
    const rules = normalizeSyncFileRules({
      includeImages: false,
      includeAudio: false,
      includeVideos: false,
      includePdf: true,
      includeOtherFiles: false,
      excludedFolders: [],
    });

    expect(shouldSyncPath("Attachments/image.png", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/sound.mp3", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/movie.mp4", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/guide.pdf", rules)).toBe(true);
    expect(shouldSyncPath("Attachments/archive.zip", rules)).toBe(false);
  });

  it("respects the catch-all other file toggle", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeOtherFiles: true,
    });

    expect(shouldSyncPath("Data/archive.zip", rules)).toBe(true);
    expect(shouldSyncPath("Data/no-extension", rules)).toBe(true);
  });

  it("excludes explicitly selected folders", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: ["Archive", "Attachments/raw"],
    });

    expect(shouldSyncPath("Archive/note.md", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/raw/image.png", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/kept/image.png", rules)).toBe(true);
  });
});

describe("normalizeIncludedHiddenFolders", () => {
  it("keeps hidden folders, deduplicates them, and removes reserved folders", () => {
    expect(
      normalizeIncludedHiddenFolders(
        [
          " .assets ",
          "/.assets/",
          "Notes/.attachments",
          ".obsidian",
          ".git",
          "Regular",
        ],
        ".obsidian",
      ),
    ).toEqual([".assets", "Notes/.attachments"]);
  });

  it("removes descendants when their ancestor is also included", () => {
    expect(normalizeIncludedHiddenFolders([".assets/raw", ".assets"])).toEqual([
      ".assets",
    ]);
  });
});

describe("normalizeExcludedFolders", () => {
  it("normalizes, deduplicates, and removes hidden folders", () => {
    expect(
      normalizeExcludedFolders([
        " Archive ",
        "/Archive/",
        "Attachments/raw",
        ".obsidian",
        ".git",
      ]),
    ).toEqual(["Archive", "Attachments/raw"]);
  });

  it("removes descendants when their ancestor is also excluded", () => {
    expect(normalizeExcludedFolders(["Foo", "Foo/Bar"])).toEqual(["Foo"]);
  });

  it("keeps independent siblings", () => {
    expect(normalizeExcludedFolders(["Foo", "Bar"])).toEqual(["Bar", "Foo"]);
  });

  it("collapses multi-level descendants under the topmost ancestor", () => {
    expect(normalizeExcludedFolders(["A", "A/B", "A/B/C", "D"])).toEqual([
      "A",
      "D",
    ]);
  });

  it("does not treat lookalike siblings as descendants", () => {
    expect(normalizeExcludedFolders(["Foo", "Foobar"])).toEqual([
      "Foo",
      "Foobar",
    ]);
  });

  it("prunes regardless of input order", () => {
    expect(normalizeExcludedFolders(["Foo/Bar", "Foo"])).toEqual(["Foo"]);
  });
});

describe("getConflictOriginalPath", () => {
  // Conflict copies are written next to the original as
  // `<stem>.sync-conflict-<timestamp>[-n]<ext>`. The resolution UI pairs a copy
  // with the file the user actually edited, so recovering the original has to
  // handle nested folders, dotted stems, missing extensions, and retry suffixes.
  it.each([
    ["note.sync-conflict-20260424-001419.md", "note.md"],
    ["Folder/note.sync-conflict-20260424-001419.md", "Folder/note.md"],
    ["Folder/note.sync-conflict-20260424-001419-2.md", "Folder/note.md"],
    [
      ".obsidian/plugins/calendar/data.sync-conflict-20260424-001419.json",
      ".obsidian/plugins/calendar/data.json",
    ],
    ["noext.sync-conflict-20260424-001419", "noext"],
    ["image.sync-conflict-20260424-001419.png", "image.png"],
    ["a/b/c/deep.sync-conflict-20260424-001419.markdown", "a/b/c/deep.markdown"],
    ["my.note.sync-conflict-20260424-001419.md", "my.note.md"],
  ])("recovers the original for %s", (input, expected) => {
    expect(getConflictOriginalPath(input)).toBe(expected);
  });

  it.each([
    ["note.md"],
    ["note.sync-conflict.md"],
    [""],
  ])("returns null for a path that is not a conflict copy: %s", (input) => {
    expect(getConflictOriginalPath(input)).toBeNull();
  });
});

describe("isImagePath", () => {
  it.each([
    ["Attachments/diagram.png", true],
    ["photo.JPG", true],
    ["image.sync-conflict-20260424-001419.webp", true],
    ["note.md", false],
    ["png", false],
    ["Folder.png/note", false],
  ])("%s -> %s", (input, expected) => {
    expect(isImagePath(input)).toBe(expected);
  });
});
