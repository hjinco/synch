import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Scenario } from "./profiles";

export type Entry = { path: string; size: number; hash: string; seed: number; changed: boolean };
export type Fixture = { version: 1; kind: Scenario["fixture"]; entries: Entry[]; bytes: number; fingerprint: string };
export const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function bytesFor(kind: Scenario["fixture"], entry: Omit<Entry, "hash">, changed: boolean): Uint8Array {
  if (kind === "mixed") return entry.path.endsWith(".bin")
    ? new Uint8Array(entry.size).fill(37)
    : new TextEncoder().encode(`# Note ${entry.seed}\n`.padEnd(entry.size, "x"));
  if (kind === "notes") return new TextEncoder().encode(`# Note ${entry.seed}\n`.padEnd(entry.size, "x"));
  const bytes = new Uint8Array(entry.size);
  const ascii = entry.path.endsWith(".md");
  const seed = entry.seed + (changed ? 900_000 : 0);
  for (let i = 0; i < bytes.length; i++) {
    const value = (i * 31 + seed * 17) % (ascii ? 95 : 256);
    bytes[i] = ascii ? 32 + value : value;
  }
  return bytes;
}

/** Plaintext recipe matches the previous workloads; IDs and encryption are per-run. */
export async function materialize(kind: Scenario["fixture"], directory: string): Promise<Fixture> {
  const recipes: Omit<Entry, "hash">[] = [];
  if (kind === "bulk") {
    for (const [folder, ext, count, size, seed, changedCount] of [
      ["notes", "md", 2048, 128 * 1024, 1, 128],
      ["attachments", "bin", 128, 4 * 1024 ** 2, 10000, 8],
      ["exports", "bin", 32, 8 * 1024 ** 2, 20000, 2],
    ] as const) for (let i = 0; i < count; i++) recipes.push({ path: `${folder}/${String(i + 1).padStart(5, "0")}.${ext}`, size, seed: seed + i, changed: i < changedCount });
  } else if (kind === "notes") {
    for (let i = 0; i < 500; i++) recipes.push({ path: `notes/entry-${String(i).padStart(4, "0")}.md`, size: 4096, seed: i, changed: false });
  } else {
    recipes.push({ path: "000-attachment.bin", size: 8 * 1024 ** 2, seed: 0, changed: false });
    for (let i = 0; i < 240; i++) recipes.push({ path: `notes/${String(i).padStart(4, "0")}.md`, size: 4096, seed: i, changed: false });
  }
  const entries: Entry[] = [];
  for (const recipe of recipes) {
    const bytes = bytesFor(kind, recipe, false);
    await mkdir(dirname(join(directory, recipe.path)), { recursive: true });
    await writeFile(join(directory, recipe.path), bytes);
    entries.push({ ...recipe, hash: hash(bytes) });
  }
  return { version: 1, kind, entries, bytes: entries.reduce((n, e) => n + e.size, 0), fingerprint: hash(JSON.stringify({ version: 1, kind, entries })) };
}

export async function applyChanges(fixture: Fixture, directory: string) {
  for (const entry of fixture.entries) if (entry.changed) {
    const bytes = bytesFor(fixture.kind, entry, true);
    await writeFile(join(directory, entry.path), bytes);
  }
}
export async function verifyFiles(fixture: Fixture, directory: string, incremental = false) {
  for (const entry of fixture.entries) {
    const bytes = await readFile(join(directory, entry.path));
    const expected = incremental && entry.changed ? hash(bytesFor(fixture.kind, entry, true)) : entry.hash;
    if (bytes.length !== entry.size || hash(bytes) !== expected) throw new Error(`Content mismatch: ${entry.path}`);
  }
}
