import { describe, expect, it, vi } from "vitest";

import {
  MAX_SYNC_DIAGNOSTIC_ENTRIES,
  MAX_SYNC_DIAGNOSTIC_TEXT_LENGTH,
  InMemorySyncDiagnostics,
} from "./in-memory";

describe("InMemorySyncDiagnostics", () => {
  it("records typed events and formats a stable snapshot", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });

    diagnostics.record({ type: "sync_started", source: "manual" });
    diagnostics.record({
      type: "sync_reconciled",
      source: "manual",
      filesScanned: 3,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 2,
    });

    expect(diagnostics.getSnapshot()).toEqual({
      count: 2,
      text: [
        "Synch sync diagnostics",
        'pluginVersion="0.3.3"',
        "entries=2",
        "",
        '[2026-08-07T00:00:00.000Z] INFO sync_started source="manual"',
        '[2026-08-07T00:00:00.000Z] INFO sync_reconciled source="manual" filesScanned=3 filesQueuedForUpsert=1 filesQueuedForDelete=2',
      ].join("\n"),
    });
  });

  it("records file paths and per-file sync flow", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });

    diagnostics.record({
      type: "local_file_queued",
      operation: "modify",
      path: "Projects/plan.md",
    });
    diagnostics.record({
      type: "file_sync_started",
      direction: "upload",
      operation: "upsert",
      path: "Projects/plan.md",
    });
    diagnostics.record({
      type: "file_sync_completed",
      direction: "upload",
      operation: "upsert",
      path: "Projects/plan.md",
      revision: 12,
    });

    const text = diagnostics.getSnapshot().text;
    expect(text).toContain(
      'local_file_queued operation="modify" path="Projects/plan.md"',
    );
    expect(text).toContain(
      'file_sync_started direction="upload" operation="upsert" path="Projects/plan.md"',
    );
    expect(text).toContain(
      'file_sync_completed direction="upload" operation="upsert" path="Projects/plan.md" revision=12',
    );
  });

  it("records a bounded error message while redacting credentials", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    const error = Object.assign(
      new Error(
        "request failed accessToken=access-secret refreshToken=refresh-secret clientSecret=client-secret path=Folder/note.md",
      ),
      {
        code: "token_expired",
        status: 401,
        sessionToken: "session-secret",
        responseBody: { secret: "must not be serialized" },
      },
    );

    diagnostics.recordError({
      phase: "auto_sync",
      error,
    });

    const text = diagnostics.getSnapshot().text;
    expect(text).toContain('name="Error"');
    expect(text).toContain(
      'message="request failed accessToken=<redacted> refreshToken=<redacted> clientSecret=<redacted> path=Folder/note.md"',
    );
    expect(text).not.toContain("token_expired");
    expect(text).toContain("status=401");
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain("refresh-secret");
    expect(text).not.toContain("client-secret");
    expect(text).toContain("Folder/note.md");
    expect(text).not.toContain("session-secret");
    expect(text).not.toContain("must not be serialized");
    expect(text).not.toContain("stack=");
  });

  it("normalizes and truncates diagnostic error messages", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });

    diagnostics.recordError({
      phase: "auto_sync",
      error: new Error(`first line\nsecond line ${"x".repeat(400)}`),
    });

    const text = diagnostics.getSnapshot().text;
    expect(text).toContain('message="first line second line ');
    expect(text).toContain('…"');
    expect(text).not.toContain("first line\\nsecond line");
    expect(text.length).toBeLessThan(500);
  });

  it("redacts authorization credentials and JWTs from error messages", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });

    diagnostics.recordError({
      phase: "auto_sync",
      error: new Error(
        "request failed Bearer bearer-secret\nAuthorization: Basic dXNlcjpwYXNz\ntoken eyJheader.payload.signature",
      ),
    });

    const text = diagnostics.getSnapshot().text;
    expect(text).toContain("Bearer <redacted>");
    expect(text).toContain("Authorization: <redacted>");
    expect(text).not.toContain("bearer-secret");
    expect(text).not.toContain("dXNlcjpwYXNz");
    expect(text).not.toContain("eyJheader.payload.signature");
  });

  it("preserves standard Web Crypto error names", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    const error = new Error("The operation failed for an operation-specific reason");
    error.name = "OperationError";

    diagnostics.recordError({ phase: "auto_sync", error });

    expect(diagnostics.getSnapshot().text).toContain(
      'name="OperationError" message="The operation failed for an operation-specific reason"',
    );
  });

  it("keeps the newest entries within the entry and text limits", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3");

    for (let index = 0; index < MAX_SYNC_DIAGNOSTIC_ENTRIES + 1; index += 1) {
      diagnostics.recordError({
        phase: "auto_sync",
        error: Object.assign(new Error("not logged"), {
          code: `entry-${index}`,
        }),
      });
    }

    expect(diagnostics.getSnapshot().count).toBeLessThanOrEqual(
      MAX_SYNC_DIAGNOSTIC_ENTRIES,
    );

    for (let index = 0; index < 100; index += 1) {
      diagnostics.recordError({
        phase: "auto_sync",
        error: new Error("x".repeat(1_000)),
      });
    }

    expect(diagnostics.getSnapshot().text.length).toBeLessThanOrEqual(
      MAX_SYNC_DIAGNOSTIC_TEXT_LENGTH,
    );
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3");
    const listener = vi.fn();
    const unsubscribe = diagnostics.subscribe(listener);

    diagnostics.record({ type: "sync_completed", source: "manual" });
    unsubscribe();
    diagnostics.record({ type: "sync_completed", source: "manual" });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears recorded diagnostics and notifies subscribers", () => {
    const diagnostics = new InMemorySyncDiagnostics("0.3.3", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    const listener = vi.fn();
    diagnostics.subscribe(listener);

    diagnostics.record({ type: "sync_started", source: "manual" });
    diagnostics.clear();

    expect(diagnostics.getSnapshot()).toEqual({
      count: 0,
      text: [
        "Synch sync diagnostics",
        'pluginVersion="0.3.3"',
        "entries=0",
      ].join("\n"),
    });
    expect(listener).toHaveBeenCalledTimes(2);

    diagnostics.clear();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("starts empty for a new execution", () => {
    expect(new InMemorySyncDiagnostics("0.3.3").getSnapshot().count).toBe(0);
  });
});
