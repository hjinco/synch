# Sync memory safety and large-file handling

Status: investigation complete; implementation pending

Last reviewed: 2026-08-29

This document tracks the memory-safety work required for large initial syncs
and large binary files. The goal is to improve this incrementally without
weakening end-to-end encryption, sync ordering, conflict handling, or retry
behavior.

## Incident summary

Synchrun can crash Obsidian during the first sync of a vault containing many
large attachments.

The observed crash is a V8 `FatalProcessOutOfMemory` / `EXC_BREAKPOINT` in an
Electron renderer process. The JavaScript heap can still be small when the
crash occurs, while the process has mapped a very large amount of virtual
address space. This points to a burst of large `ArrayBuffer` allocations and
copies exhausting the V8/Electron address-space budget rather than ordinary
steady heap growth.

The repository does not contain an explicit `Worker` or `postMessage` for blob
processing. The `DedicatedWorker` in the crash stack is therefore likely an
Electron, WebCrypto, or native HTTP implementation detail. Synch still creates
the large buffers that are passed through those layers.

## Current data flow

### Local reconciliation

`SyncLocalReconcileService` hashes changed files with a pool of eight workers:

- `packages/sync-client/src/sync/engine/local-reconcile-service.ts`
- `apps/obsidian-plugin/src/adapters/vault-adapter.ts`

Each `SyncVaultFile.readBytes()` call returns the complete file as a
`Uint8Array`. The pool limits the number of files, but has no limit on the sum
of their sizes. This stage returns hashes rather than retaining the file bytes,
so its retention is shorter than the push stage, but a few very large files can
still exceed a safe memory budget.

### Push preparation

The push path is the highest-risk path for an initial local upload:

1. `SyncPushService` loads up to 100 pending mutations.
2. It prepares up to 12 mutations concurrently.
3. `PushMutationPreparer` reads the complete file, hashes it, and encrypts the
   complete file with the v2 AES-GCM envelope.
4. The prepared results retain `encryptedBytes` until the whole mutation batch
   is committed.

The result is bounded by mutation count, not by bytes. Depending on timing,
the process may hold plaintext, WebCrypto temporary ciphertext, the final
encrypted envelope, an HTTP body copy, and up to 100 completed encrypted
results at the same time.

The current file-size check happens after the complete encryption step. A
server or plan limit therefore prevents the upload but does not prevent the
memory spike caused by reading and encrypting the oversized file.

`SyncBlobClient` also makes an unconditional `Uint8Array.slice()` before
passing the body to Obsidian's `requestUrl`, creating an avoidable full-size
copy. The shared `toArrayBuffer` helper already avoids this copy when the view
covers its complete backing buffer.

### Pull preparation

The pull path has the same class of risk for large remote changes:

- the normal pull service prepares up to 10 blobs concurrently;
- a pull window can contain up to 200 entries;
- blob preparation downloads, decrypts, and hashes complete files;
- the current application plan prepares all blobs for the window before
  writing the vault paths.

The existing test named `prepares all blobs before writing a large pull` makes
this behavior explicit. It should become a bounded, per-application-batch
contract instead.

### Transport boundary

The API already accepts a `ReadableStream` and the R2/local-disk adapters can
stream the server-side body. The Obsidian client boundary currently exposes
`ArrayBuffer` request bodies and `ArrayBuffer` download responses through
`requestUrl`, so the client still materializes complete blobs. The S3 object
storage adapter also currently materializes an entire upload before sending it
to S3; this is a separate server-side memory concern to address when true
streaming is implemented.

## Safety invariants

Every implementation should preserve these invariants:

1. Plaintext file contents must not be persisted in the sync store or an
   unencrypted temporary queue.
2. In-flight memory must be bounded by total bytes, not only by task count.
3. A memory reservation must remain held until the last consumer releases the
   corresponding buffer. Returning from a worker is not sufficient if a result
   array still retains the bytes.
4. File-size limits must be checked before expensive encryption whenever the
   file size is known. The encrypted envelope overhead must be included by a
   shared crypto helper rather than duplicated as a magic number.
5. Hash verification and the existing read/change race handling must remain in
   place.
6. Push commit ordering, pull cursor checkpointing, conflict handling, and
   retry behavior must not change as a side effect of adding backpressure.
7. A future chunked format must use a unique nonce for every chunk. Chunk AAD
   must bind at least the blob id and chunk index, and framing must prevent
   reordering, truncation, or cross-blob substitution.
8. Existing v2 blobs must remain readable during a format migration.

## Incremental roadmap

### P0: immediate crash-risk reduction

- [ ] Use conservative defaults for local hashing and push/pull preparation
      while the byte-budgeted scheduler is being implemented.
- [ ] Reduce or remove push-batch retention of large buffers. After a binary
      upload succeeds, discard `encryptedBytes`; only Markdown currently needs
      the encrypted remote cache for merge bases.
- [ ] Avoid the unconditional upload-side `Uint8Array` copy.
- [ ] Add a preflight size check before encryption. Prefer a platform `stat`
      operation so an oversized file can be rejected before it is read.
- [ ] Make the blocked-file state and retry path work when the decision is
      made from stat information rather than from an already encrypted blob.
- [ ] Add throttled initial-scan progress, including file and byte totals.

P0 is a mitigation, not the final large-file solution. Serial processing still
cannot make a single multi-gigabyte whole-file read safe.

### P1: shared byte-based backpressure

- [ ] Add a shared weighted semaphore/resource budget for local reconcile, push,
      and pull preparation.
- [ ] Reserve an estimated peak footprint before reading. The estimate must
      account for plaintext, encryption/decryption output, and known transport
      copies; keep the estimate conservative.
- [ ] Hold a lease until the buffer is no longer retained by the caller,
      upload, commit preparation, cache write, or vault write.
- [ ] Replace duplicated count-only `mapWithConcurrency` implementations with
      one tested byte-aware scheduler.
- [ ] Refactor push into a bounded producer/consumer pipeline so a whole batch
      does not retain large encrypted payloads.
- [ ] Refactor pull to prepare and apply one dependency-safe path batch at a
      time instead of preparing every blob in an apply window up front.
- [ ] Add cancellation so stopping or disabling sync can release pending work
      promptly.

The existing `SyncVaultFile` and `LocalFileReader` ports expose only complete
file reads. They need at least a reliable stat operation for P1 and a streaming
or range-read operation for P2.

### P2: true streaming and chunked blobs

- [ ] Define a new versioned encrypted blob format for fixed-size chunks.
- [ ] Stream or range-read local files so a complete plaintext file is never
      required in the JavaScript heap.
- [ ] Hash and encrypt chunks incrementally with bounded memory.
- [ ] Add a resumable/chunk-capable client and API transport compatible with
      Obsidian's HTTP constraints.
- [ ] Use multipart or equivalent streaming upload for the S3 server adapter.
- [ ] Keep v2 read compatibility and migrate only newly written blobs to the
      new format until all supported clients can read it.

Do not implement P2 by merely splitting an already materialized whole-file
buffer. That reduces encryption payload size but does not fix the initial
`readBinary()` allocation.

## Tests and acceptance criteria

The tests should verify behavior rather than implementation details:

- [ ] A synthetic set of large files never exceeds the configured total
      in-flight byte budget.
- [ ] A file over the configured size limit is blocked without calling full
      blob encryption.
- [ ] A completed binary upload does not retain its encrypted payload until an
      unrelated batch finishes.
- [ ] Pull writes can begin before all blobs in a large remote change set have
      been prepared, subject to path dependencies.
- [ ] Hashes, encrypted envelope authentication, retries, conflicts, and
      cursor checkpoints remain correct.
- [ ] Chunked encryption rejects tampered, reordered, truncated, and
      cross-blob chunks.
- [ ] A reproduction vault with several gigabytes of large binaries completes
      initial sync without renderer termination and exposes useful progress.

Use fake byte sizes and deferred readers in unit tests rather than allocating
multi-gigabyte fixtures. Keep one end-to-end validation run against a real
large-file vault before shipping the fix.

## Related documentation and code

- [Sync format](sync-format.md)
- [Sync cursor checkpointing](sync-cursor-checkpointing.md)
- `packages/sync-client/src/sync/engine/local-reconcile-service.ts`
- `packages/sync-client/src/sync/engine/push-service.ts`
- `packages/sync-client/src/sync/engine/push-mutation-preparer.ts`
- `packages/sync-client/src/sync/engine/pull-blob-preparer.ts`
- `packages/sync-client/src/sync/engine/pull-entry-state-applier.ts`
- `packages/sync-client/src/sync/core/crypto.ts`
