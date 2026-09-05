import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncCryptoContext, hashBytes } from "../src/index";
import type { BenchmarkFixture, BenchmarkFixtureEntry } from "./benchmark-fixture";

export const PULL_NOTES_FIXTURE_SPEC = { notes: 500, noteBytes: 4 * 1024 } as const;

/** Shared encrypted inputs; every timed run gets its own empty filesystem vault. */
export async function createPullNotesFixture(key: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "synch-pull-notes-"));
  const crypto = createSyncCryptoContext(key);
  const baseline: BenchmarkFixtureEntry[] = [];
  try {
    for (let index = 0; index < PULL_NOTES_FIXTURE_SPEC.notes; index++) {
      const entryId = `entry-${String(index).padStart(4, "0")}`;
      const blobId = `${entryId}-blob`;
      const path = `notes/${entryId}.md`;
      const bytes = new TextEncoder().encode(
        `# Note ${index}\n`.padEnd(PULL_NOTES_FIXTURE_SPEC.noteBytes, "x"),
      );
      const hash = await hashBytes(bytes);
      const bytesFile = `${entryId}.md`;
      const encryptedBlobFile = `${blobId}.bin`;
      const bytesPath = join(directory, bytesFile);
      const encryptedBlobPath = join(directory, encryptedBlobFile);
      await writeFile(bytesPath, bytes);
      await writeFile(encryptedBlobPath, await crypto.encryptBlob(bytes, { blobId }));
      baseline.push({
        entryId, blobId, path, size: bytes.byteLength, hash,
        revision: 1, updatedSeq: index + 1, updatedAt: index + 1,
        encryptedMetadata: await crypto.encryptMetadata({ path, hash }, {
          entryId, revision: 1, op: "upsert", blobId,
        }),
        bytesFile, encryptedBlobFile, bytesPath, encryptedBlobPath,
      });
    }
    const fixture: BenchmarkFixture = {
      directory, filesDirectory: directory, baseline, incremental: baseline,
      incrementalCursor: baseline.length,
    };
    return { fixture, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    crypto.dispose();
  }
}
