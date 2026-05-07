import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  normalizeExcludedFolders,
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

  it("excludes Obsidian configuration files even when other files are enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeOtherFiles: true,
    });

    expect(shouldSyncPath(".obsidian/app.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/snippets/tweaks.css", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/calendar/data.json", rules)).toBe(false);
    expect(shouldSyncPath(".git/config", rules)).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", rules)).toBe(false);
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
