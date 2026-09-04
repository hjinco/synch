# Sync memory safety and large-file handling

Status: investigation complete; read/hash backpressure implemented,
full large-file handling pending

Last reviewed: 2026-09-03

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

At the time of the original investigation, the repository did not contain an
application-owned `Worker` or `postMessage` for blob processing. The
`DedicatedWorker` in the crash stack was therefore likely an Electron,
WebCrypto, or native HTTP implementation detail. Synch still creates the
large buffers that are passed through those layers.

The current implementation now has an explicit SHA-256 worker pool, but it
still materializes whole-file buffers and does not by itself solve the larger
streaming problem.

## Current data flow

### Local reconciliation

`SyncLocalReconcileService` hashes changed files with operation-level
concurrency and the shared SHA-256 worker pool:

- `packages/sync-client/src/sync/engine/local-reconcile-service.ts`
- `apps/obsidian-plugin/src/adapters/vault-adapter.ts`

Each `SyncVaultFile.readBytes()` call returns the complete file as a
`Uint8Array`. The operation still limits the number of files to eight by
default, and each read now enters the shared `SyncContentRuntime` byte budget
before the reader starts. The budget limits the sum of admitted read-to-hash
bytes, but it is not a complete process-memory cap and a single very large
whole-file read can still exceed the environment's safe allocation size.

### Push preparation

The push path is the highest-risk path for an initial local upload:

1. `SyncPushService` loads up to 100 pending mutations.
2. It prepares up to 12 mutations concurrently.
3. `PushMutationPreparer` reads the complete file, hashes it, and encrypts the
   complete file with the v2 AES-GCM envelope.
4. Markdown prepared results retain `encryptedBytes` as a remote merge base;
   binary prepared results release it after a successful upload.

The read-to-hash part is now admitted through the shared byte budget. After a
successful upload, binary prepared results no longer retain `encryptedBytes`;
only Markdown retains the encrypted payload needed as a remote merge base.
Encryption output, WebCrypto temporary buffers, HTTP body copies, and the
remaining prepared results are still outside the byte reservation boundary.

The current file-size check happens after the complete encryption step. A
server or plan limit therefore prevents the upload but does not yet prevent
the memory spike caused by reading and encrypting the oversized file. The
pre-read stat is currently used for backpressure, not for an encrypted-size
preflight rejection.

`SyncBlobClient` now passes the shared `toArrayBuffer` result to the request
client. Exact views avoid an additional full-size copy; partial views still
need a copy.

### Pull preparation

The pull path has the same class of risk for large remote changes:

- the normal pull service prepares up to 10 blobs concurrently;
- a pull window can contain up to 100 entries;
- blob preparation downloads, decrypts, and hashes complete files;
- the current application plan prepares all blobs for the window before
  writing the vault paths.

Pull and push now share one `SyncContentRuntime` per `SyncEngine`, so their
SHA-256 work is served by the same worker pool. Local pending-mutation, merge,
and conflict-copy reads also use the shared byte budget. Downloaded remote
blobs are already materialized before verification and remain outside that
local-read reservation.

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

- [x] Bound SHA-256 worker concurrency and local read/hash admission through
      the shared content runtime.
- [x] Reduce push-batch retention of large buffers. After a binary upload
      succeeds, discard `encryptedBytes`; only Markdown needs the encrypted
      remote cache for merge bases.
- [x] Avoid the unconditional upload-side `Uint8Array` copy.
- [ ] Add a preflight size check before encryption. Prefer a platform `stat`
      operation so an oversized file can be rejected before it is read.
- [ ] Make the blocked-file state and retry path work when the decision is
      made from stat information rather than from an already encrypted blob.
- [ ] Add throttled initial-scan progress, including file and byte totals.

P0 is a mitigation, not the final large-file solution. Serial processing still
cannot make a single multi-gigabyte whole-file read safe.

### P1: shared byte-based backpressure

The read-to-hash portion of P1 is implemented by
[SyncContentRuntime](sync-content-processing.md): local reconciliation, push
preparation, and local pull reads share a 512 MiB weighted budget, and the
browser uses one bounded SHA-256 worker pool per `SyncEngine`. The remaining
items below are still open.

- [x] Add a shared weighted semaphore/resource budget for local reconciliation,
      push read/hash, and local pull reads.
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

Production vault access now exposes `getFileSize` for pre-read admission, but
the ports still expose only complete file reads. Streaming or range reads
remain a P2 requirement.

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
