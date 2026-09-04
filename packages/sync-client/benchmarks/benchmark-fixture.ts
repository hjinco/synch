import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createSyncCryptoContext,
  hashBytes,
} from "../src/index";

const FIXTURE_VERSION = 2;
const MEBIBYTE = 1024 * 1024;

export const FIXTURE_TOTAL_BYTES = 1024 * MEBIBYTE;
export const DEFAULT_FIXTURE_DIRECTORY = resolve(
  process.env.SYNCH_SYNC_CLIENT_FIXTURE_DIR ?? "benchmarks/fixtures/1gb",
);

type FixtureManifestEntry = {
  entryId: string;
  path: string;
  size: number;
  hash: string;
  blobId: string;
  revision: number;
  updatedSeq: number;
  updatedAt: number;
  encryptedMetadata: string;
  bytesFile: string;
  encryptedBlobFile: string;
};

type FixtureManifest = {
  version: number;
  totalBytes: number;
  baseline: FixtureManifestEntry[];
  incremental: FixtureManifestEntry[];
};

export type BenchmarkFixtureEntry = FixtureManifestEntry & {
  bytesPath: string;
  encryptedBlobPath: string;
};

export type BenchmarkFixture = {
  directory: string;
  filesDirectory: string;
  baseline: BenchmarkFixtureEntry[];
  incremental: BenchmarkFixtureEntry[];
  incrementalCursor: number;
};

const FIXTURE_SPECS = [
  {
    directory: "notes",
    extension: ".md",
    count: 2_048,
    size: 128 * 1024,
    seed: 1,
  },
  {
    directory: "attachments",
    extension: ".bin",
    count: 128,
    size: 4 * MEBIBYTE,
    seed: 10_000,
  },
  {
    directory: "exports",
    extension: ".bin",
    count: 32,
    size: 8 * MEBIBYTE,
    seed: 20_000,
  },
] as const;

const FIXTURE_ENTRY_COUNT = FIXTURE_SPECS.reduce(
  (total, spec) => total + spec.count,
  0,
);

let fixturePromise: Promise<BenchmarkFixture> | null = null;

export function loadBenchmarkFixture(): Promise<BenchmarkFixture> {
  fixturePromise ??= loadOrCreateFixture(DEFAULT_FIXTURE_DIRECTORY);
  return fixturePromise;
}

async function loadOrCreateFixture(directory: string): Promise<BenchmarkFixture> {
  const manifestPath = join(directory, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
    if (manifest.version !== FIXTURE_VERSION) {
      return await createFixture(directory, manifestPath);
    }
    await validateManifest(directory, manifest);
    return materializeFixture(directory, manifest);
  } catch (error) {
    if (isMissingFileError(error)) {
      return await createFixture(directory, manifestPath);
    }
    throw new Error(
      `Invalid sync-client benchmark fixture at ${directory}. ` +
        "Remove the incomplete fixture or point SYNCH_SYNC_CLIENT_FIXTURE_DIR " +
        "at a valid generated fixture.",
    );
  }
}

async function createFixture(
  directory: string,
  manifestPath: string,
): Promise<BenchmarkFixture> {
  const filesDirectory = join(directory, "files");
  const blobsDirectory = join(directory, "blobs");
  const variantsDirectory = join(directory, "variants");
  await mkdir(filesDirectory, { recursive: true });
  await mkdir(blobsDirectory, { recursive: true });
  await mkdir(variantsDirectory, { recursive: true });

  console.info(
    `[sync-client benchmark] creating ${FIXTURE_TOTAL_BYTES / MEBIBYTE} MiB fixture at ${directory}`,
  );

  const baseline: FixtureManifestEntry[] = [];
  const changed: FixtureManifestEntry[] = [];
  let sequence = 0;
  let changedSequence = 0;
  const cryptoContext = createSyncCryptoContext(REMOTE_VAULT_KEY);

  try {
    for (const spec of FIXTURE_SPECS) {
      for (let index = 0; index < spec.count; index += 1) {
        sequence += 1;
        const path = `${spec.directory}/${String(index + 1).padStart(5, "0")}${spec.extension}`;
        const entryId = `entry-${String(sequence).padStart(5, "0")}`;
        const bytesFile = join("files", path);
        const bytesPath = join(directory, bytesFile);
        await ensureDeterministicFile(bytesPath, spec.size, spec.seed + index, spec.extension === ".md");
        const baselineEntry = await createManifestEntry({
          directory,
          bytesPath,
          bytesFile,
          entryId,
          path,
          revision: 1,
          updatedSeq: sequence,
          cryptoContext,
        });
        baseline.push(baselineEntry);

        if (!shouldChange(spec.directory, index)) {
          continue;
        }

        changedSequence += 1;
        const changedBytesFile = join("variants", "v2", path);
        const changedBytesPath = join(directory, changedBytesFile);
        await ensureDeterministicFile(
          changedBytesPath,
          spec.size,
          spec.seed + index + 900_000,
          spec.extension === ".md",
        );
        changed.push(
          await createManifestEntry({
            directory,
            bytesPath: changedBytesPath,
            bytesFile: changedBytesFile,
            entryId,
            path,
            revision: 2,
            updatedSeq: FIXTURE_ENTRY_COUNT + changedSequence,
            cryptoContext,
          }),
        );
      }
    }
  } finally {
    cryptoContext.dispose();
  }

  const changedByEntryId = new Map(changed.map((entry) => [entry.entryId, entry]));
  const manifest: FixtureManifest = {
    version: FIXTURE_VERSION,
    totalBytes: baseline.reduce((total, entry) => total + entry.size, 0),
    baseline,
    incremental: baseline.map(
      (entry) => changedByEntryId.get(entry.entryId) ?? entry,
    ),
  };
  if (manifest.totalBytes !== FIXTURE_TOTAL_BYTES) {
    throw new Error(
      `Generated benchmark fixture has ${manifest.totalBytes} bytes; expected ${FIXTURE_TOTAL_BYTES}.`,
    );
  }

  const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporaryManifestPath, JSON.stringify(manifest));
  await rename(temporaryManifestPath, manifestPath);
  return materializeFixture(directory, manifest);
}

async function createManifestEntry(input: {
  directory: string;
  bytesPath: string;
  bytesFile: string;
  entryId: string;
  path: string;
  revision: number;
  updatedSeq: number;
  cryptoContext: ReturnType<typeof createSyncCryptoContext>;
}): Promise<FixtureManifestEntry> {
  const bytes = new Uint8Array(await readFile(input.bytesPath));
  const hash = await hashBytes(bytes);
  const blobId = `${input.entryId}-blob-${input.revision}`;
  const encryptedBlobFile = join("blobs", `${blobId}.bin`);
  const encryptedBlobPath = join(input.directory, encryptedBlobFile);
  const encryptedMetadata = await input.cryptoContext.encryptMetadata(
    { path: input.path, hash },
    {
      entryId: input.entryId,
      revision: input.revision,
      op: "upsert",
      blobId,
    },
  );
  const encryptedBytes = await input.cryptoContext.encryptBlob(bytes, { blobId });
  if (!(await fileHasSize(encryptedBlobPath, encryptedBytes.byteLength))) {
    await mkdir(dirname(encryptedBlobPath), { recursive: true });
    await writeFile(encryptedBlobPath, encryptedBytes);
  }

  return {
    entryId: input.entryId,
    path: input.path,
    size: bytes.byteLength,
    hash,
    blobId,
    revision: input.revision,
    updatedSeq: input.updatedSeq,
    updatedAt: input.updatedSeq,
    encryptedMetadata,
    bytesFile: input.bytesFile,
    encryptedBlobFile,
  };
}

function materializeFixture(
  directory: string,
  manifest: FixtureManifest,
): BenchmarkFixture {
  const materialize = (entry: FixtureManifestEntry): BenchmarkFixtureEntry => ({
    ...entry,
    bytesPath: join(directory, entry.bytesFile),
    encryptedBlobPath: join(directory, entry.encryptedBlobFile),
  });
  const baseline = manifest.baseline.map(materialize);
  const incremental = manifest.incremental.map(materialize);
  return {
    directory,
    filesDirectory: join(directory, "files"),
    baseline,
    incremental,
    incrementalCursor: Math.max(...incremental.map((entry) => entry.updatedSeq)),
  };
}

async function validateManifest(
  directory: string,
  manifest: FixtureManifest,
): Promise<void> {
  if (
    manifest.version !== FIXTURE_VERSION ||
    manifest.totalBytes !== FIXTURE_TOTAL_BYTES ||
    !Array.isArray(manifest.baseline) ||
    !Array.isArray(manifest.incremental) ||
    manifest.baseline.length !== FIXTURE_ENTRY_COUNT ||
    manifest.incremental.length !== manifest.baseline.length
  ) {
    throw new Error("benchmark manifest header does not match the 1 GiB fixture");
  }

  for (const entry of [...manifest.baseline, ...manifest.incremental]) {
    if (
      !(await fileHasSize(join(directory, entry.bytesFile), entry.size)) ||
      !(await fileHasSize(join(directory, entry.encryptedBlobFile)))
    ) {
      throw new Error(`benchmark fixture file is missing: ${entry.path}`);
    }
  }
}

async function ensureDeterministicFile(
  filePath: string,
  size: number,
  seed: number,
  ascii: boolean,
): Promise<void> {
  if (await fileHasSize(filePath, size)) {
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, createBytes(size, seed, ascii));
}

function createBytes(size: number, seed: number, ascii: boolean): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    const value = (index * 31 + seed * 17) % (ascii ? 95 : 256);
    bytes[index] = ascii ? 32 + value : value;
  }
  return bytes;
}

function shouldChange(directory: string, index: number): boolean {
  return (
    (directory === "notes" && index < 128) ||
    (directory === "attachments" && index < 8) ||
    (directory === "exports" && index < 2)
  );
}

async function fileHasSize(filePath: string, expectedSize?: number): Promise<boolean> {
  try {
    const file = await stat(filePath);
    return expectedSize === undefined || file.size === expectedSize;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const REMOTE_VAULT_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index + 1),
);
