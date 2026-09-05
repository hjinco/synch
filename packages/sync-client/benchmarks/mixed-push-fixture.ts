import { hashBytes } from "../src/index";
import { createBenchmarkVault } from "./benchmark-vault";

export const MIXED_PUSH_FIXTURE_SPEC = {
  notes: 240,
  noteBytes: 4 * 1024,
  attachmentBytes: 8 * 1024 * 1024,
} as const;

export type MixedPushFixtureEntry = {
  path: string;
  size: number;
  hash: string;
};

/** Creates an isolated vault and expected content in attachment-first queue order. */
export async function createMixedPushFixture() {
  const vault = await createBenchmarkVault(null);
  const entries: MixedPushFixtureEntry[] = [];

  async function addFile(path: string, bytes: Uint8Array): Promise<void> {
    await vault.adapter.writeBinary(path, bytes);
    entries.push({ path, size: bytes.byteLength, hash: await hashBytes(bytes) });
  }

  try {
    await addFile(
      "000-attachment.bin",
      new Uint8Array(MIXED_PUSH_FIXTURE_SPEC.attachmentBytes).fill(37),
    );
    const encoder = new TextEncoder();
    for (let index = 0; index < MIXED_PUSH_FIXTURE_SPEC.notes; index += 1) {
      await addFile(
        `notes/${String(index).padStart(4, "0")}.md`,
        encoder.encode(`# Note ${index}\n`.padEnd(MIXED_PUSH_FIXTURE_SPEC.noteBytes, "x")),
      );
    }
    return { ...vault, entries };
  } catch (error) {
    await vault.dispose();
    throw error;
  }
}
