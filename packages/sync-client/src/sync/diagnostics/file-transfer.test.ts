import { expect, it, vi } from "vitest";
import { FileTransferLog } from "./file-transfer";
import { InMemorySyncDiagnostics } from "./in-memory";

it("persists a large file's start before work and records a failed stage", async () => {
  const diagnostics = new InMemorySyncDiagnostics("test");
  let release!: () => void;
  const checkpoint = new Promise<void>((resolve) => { release = resolve; });
  const transfer = new FileTransferLog(Object.assign(diagnostics, {
    flush: () => checkpoint,
  }), "download", "attachment.pdf", 40 * 1024 ** 2);
  const work = vi.fn(async () => { throw new Error("interrupted"); });
  const pending = transfer.run("download", work);
  expect(work).not.toHaveBeenCalled();
  expect(diagnostics.getSnapshot().text).toContain('status="started"');
  release();
  await expect(pending).rejects.toThrow("interrupted");
  expect(diagnostics.getSnapshot().text).toContain('status="failed"');
});

it("identifies a transfer even after its first stage ages out", async () => {
  const diagnostics = new InMemorySyncDiagnostics("test");
  const transfer = new FileTransferLog(diagnostics, "download", "large.pdf", 40 * 1024 ** 2);
  await transfer.start("download");
  for (let i = 0; i < 1000; i++) diagnostics.record({ type: "sync_started", source: "manual" });
  await transfer.start("decrypt");
  expect(diagnostics.getSnapshot().text).toContain('stage="decrypt" status="started" path="large.pdf" sizeBytes=41943040');
});
