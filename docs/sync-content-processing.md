# Sync content processing

Status: implemented for whole-file read and hash paths

Last reviewed: 2026-09-03

This document describes how the sync client reads file content, computes
SHA-256 hashes, and limits concurrent content work. The design keeps CPU
concurrency and byte-based backpressure separate, while giving one
SyncEngine a single content runtime shared by push and pull.

## Architecture

~~~mermaid
flowchart TD
    engine[SyncEngine] --> runtime[SyncContentRuntime]
    runtime --> pool[SHA-256 worker pool]
    runtime --> budget[Bytes-in-flight budget]
    engine --> reconcile[Local reconciliation]
    engine --> push[Push preparation]
    engine --> pull[Pull preparation and local merge]
    engine --> recorder[Event recording and version history]
    reconcile --> runtime
    push --> runtime
    pull --> runtime
    recorder --> runtime
~~~

For one SyncEngine, push and pull use the same SyncContentRuntime instance.
That means they share both the SHA-256 worker pool and the byte budget; a
pull-specific or push-specific hash pool is not created.

The runtime is defined in
packages/sync-client/src/sync/core/content-runtime.ts. Its default components
are a browser SHA-256 worker pool when Web Workers are available and a direct
WebCrypto implementation otherwise.

## Runtime API

| API | Use | Reservation and ownership |
| --- | --- | --- |
| `hash(bytes)` | Hash bytes that the caller must keep unchanged. | Copies the input before sending it to a worker. It does not create a byte-budget reservation. |
| `hashAndReturnBytes(bytes)` | Hash bytes while continuing with the same byte buffer. | The browser worker may transfer an exact input buffer and return it with the digest. Callers should use the returned bytes and treat the input as consumed. |
| `readAndHash(size, readBytes)` | Read a local file and hash it. | Acquires `size` before invoking the reader and releases it after hashing succeeds or fails. |
| `withReadBytes(size, readBytes, work)` | Read local bytes for a merge or conflict operation without necessarily hashing them. | Holds the reservation through the callback, then releases it in a `finally` path. |
| `dispose()` | Stop content processing. | Disposes components created by the runtime and rejects queued work. Injected components remain owned by their caller. |

`readAndHash` is the normal boundary for a local file read. The reader is not
called until the reservation has been granted, so operation-level task
concurrency cannot bypass the byte limit.

## SHA-256 worker pool

The implementation in
packages/sync-client/src/sync/core/sha256-worker-pool.ts has these properties:

- The default concurrency is `max(1, min(4, floor(hardwareConcurrency / 2)))`.
  Explicit concurrency values are clamped to the same range.
- Requests are queued and assigned to fixed worker slots with request IDs.
  A slot starts the next queued request after its current request completes.
- The browser worker is created from an inline Blob source, so the plugin does
  not need a separately served worker asset.
- The worker runs `crypto.subtle.digest("SHA-256", buffer)` and returns the
  digest. `hashAndReturnBytes` also transfers the original buffer back to the
  caller.
- If a worker fails, its current request is rejected and the slot is
  replaced. Disposing the pool rejects queued and active requests, terminates
  workers, and revokes the Blob URL.
- Hosts without the Worker/Blob APIs use the direct WebCrypto fallback.

The pool is a CPU/concurrency control. It is deliberately independent from
the byte budget: four small files and four very large files both consume four
hash slots, but their memory impact is different.

### Buffer ownership

`hash(bytes)` is non-destructive and copies the input before transfer.
`hashAndReturnBytes(bytes)` is the ownership-aware path. If the input is an
exact view over its ArrayBuffer, the browser implementation transfers that
ArrayBuffer instead of making another full-file copy. A subarray or partial
view is copied first so unrelated bytes are not transferred.

For portability, callers of `hashAndReturnBytes` should not depend on the
source view remaining usable while the operation is pending. They should use
the returned `HashedBytes.bytes` value.

## Byte-based backpressure

`BytesInFlightBudget` in
packages/sync-client/src/sync/core/bytes-in-flight.ts uses a weighted
reservation rather than a task count.

- `MAX_BYTES_IN_FLIGHT` is 512 MiB.
- A normal request is admitted when the sum of active reservations remains
  within the limit.
- A request larger than the limit is admitted exclusively when no other
  reservation is active. This prevents a single large file from waiting
  forever, while keeping it isolated from other reads.
- Reservations are released in `finally`, including reader and hash errors.
- The queue grants any waiting request that fits. A small file can therefore
  continue while an oversized request is waiting for exclusive access.

The current budget covers the local read-to-hash window and local read
callbacks. It is not a complete process-memory limit: encrypted output
retained after hashing, HTTP request copies, and downloaded remote pull blobs
are outside this reservation boundary. Whole-file reads are still used, so
streaming or chunked encryption is a separate future change.

## Operation flows

### Local reconciliation

The scanner supplies each file's size and reader. The reconcile service keeps
its operation-level concurrency, then calls:

~~~text
file.size -> runtime.readAndHash(file.size, file.readBytes)
          -> compare the hash with local sync state
          -> update or queue the local mutation
~~~

The default reconcile task concurrency is eight, but the shared worker pool
and byte budget provide the cross-operation limits.

### Push

Push preparation first obtains the local file size, then reads and hashes the
file through the runtime. The mutation hash is checked before encryption and
upload:

~~~text
getFileSize -> runtime.readAndHash -> verify mutation hash
            -> encrypt locally -> upload encrypted blob -> commit mutation
~~~

The default push preparation task concurrency is twelve. The byte reservation
ends after hashing, before encryption and upload. After a successful upload,
only Markdown encrypted payloads are retained as remote merge bases; binary
payloads are released from the prepared result.

### Pull

Remote pull blobs are downloaded and decrypted locally, then verified through
the shared runtime:

~~~text
download encrypted blob -> decrypt locally -> runtime.hashAndReturnBytes
                         -> verify hash -> write the vault or cache a merge base
~~~

The default pull preparation task concurrency is ten when driven by
SyncPullService. Downloaded remote buffers are already materialized before
this hash call, so they do not use `readAndHash`'s local-read reservation.

Local pending-mutation checks, text merges, and conflict-copy reads use
`getFileSize` plus `withReadBytes` so local reads still participate in the
shared byte budget.

## Lifecycle and dependency ownership

SyncEngine creates one runtime unless a `contentRuntime` is injected. It
passes that instance to local reconciliation, push, pull, event recording,
version history, and vault-config reapplication.

The engine owns and disposes a runtime that it created itself. An injected
runtime is caller-owned and is not disposed by SyncEngine. This keeps tests
and explicitly managed hosts able to supply a deterministic hasher or budget
without creating hidden pools.

When a service is constructed in isolation without a runtime,
`resolveSyncContentRuntime` creates one for that isolated service. The normal
SyncEngine path always supplies the shared instance.

## Security and correctness boundaries

Workers receive plaintext bytes only to calculate a local SHA-256 digest; the
worker does not perform network I/O or change the encryption boundary. Push
still encrypts before upload, and pull still decrypts before local vault
writes.

When adding a new content path:

1. Obtain the exact local file size before calling its reader.
2. Use `runtime.readAndHash` for a local read whose result is hashed.
3. Use `runtime.withReadBytes` when a local read is needed for a callback such
   as merge or conflict handling.
4. Use `runtime.hashAndReturnBytes` when already-materialized bytes must be
   hashed and retained by the caller.
5. Keep the runtime at the engine boundary; do not create a worker pool or
   byte budget inside an operation service.

The runtime's read reservation ends when hashing or the supplied callback ends.
If a future operation retains large plaintext while encrypting, uploading, or
writing it, the reservation boundary must be extended explicitly rather than
assuming that the current read budget covers those later buffers.

## Tests

The behavior is covered by:

- `packages/sync-client/src/sync/core/sha256-worker-pool.test.ts`
- `packages/sync-client/src/sync/core/bytes-in-flight.test.ts`

Useful verification commands are:

~~~sh
pnpm -C packages/sync-client typecheck
pnpm -C packages/sync-client test -- --run
pnpm -C apps/obsidian-plugin typecheck
pnpm -C apps/obsidian-plugin test -- --run
~~~

## Related documentation

- [Sync memory safety and large-file handling](sync-memory-safety.md)
- [Sync format](sync-format.md)
- [Sync cursor checkpointing](sync-cursor-checkpointing.md)
