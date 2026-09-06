# Sync benchmarks

System-level sync measurements against the production API over real HTTP and
WebSocket. Local Cloudflare is the default; Node measures the self-hosted backend.
The measured client uses Node, an ordinary filesystem vault and an in-memory sync
store. Results do not represent deployed Cloudflare latency, Obsidian/Dexie, browser
workers, mobile performance, or shared network bandwidth.

Requires Node 24, `pnpm install --frozen-lockfile`, and permission to listen on
loopback ports and start child processes. No deployed service, Cloudflare account,
Obsidian installation, or local `.env` is needed. Temporary servers use synthetic
accounts, real password-wrapped keys, and isolated storage.

## Run

From the repository root:

```sh
pnpm bench:sync -- --runtime cloudflare --suite quick
pnpm bench:sync -- --runtime node --suite full
pnpm bench:sync -- --runtime node --scenario pull-notes-no-delay --iterations 1 --warmup 0 --output /tmp/sync-run.json
pnpm bench:sync:compare -- --base origin/main --runtime cloudflare --suite quick
```

Comparison defaults to a snapshot of the current working tree, including tracked
edits and non-ignored untracked files. To compare committed revisions, specify
`--candidate HEAD` or another git ref. Both revisions run from temporary detached
worktrees. The same frozen benchmark/testkit files and measurement dependencies are
staged into each, while production code and dependencies come from each checkout's
own frozen lockfile. Product lockfiles are not rewritten to install the driver.
This also supports baselines predating the new benchmark directory, provided their
public client exports remain compatible. Incompatible drivers fail explicitly.

Default output is `benchmark-results/run.json` or `benchmark-results/comparison.json`.
These paths are ignored by git and survive temporary cleanup. Use a distinct
`--output` for every result you want to retain. Partial results are saved after each
sample. Reports retain source/definition/fixture identities, runtime versions,
configuration fingerprints, raw timings, failed samples and completion metrics.
Run comparisons sequentially on an otherwise idle machine; do not compare timings
from concurrent validation runs or different environments.

## Suites and workload recipes

`quick` runs the six mixed/pagination profiles. `full` adds three bulk scenarios.
Each profile uses one discarded rehearsal and five measured samples by default.
`--iterations` accepts 1–100; `--warmup` accepts 0–10. A single sample is useful for
correctness verification, not evidence of a performance improvement.

| Scenario | Data and operation |
| --- | --- |
| `initial-pull-1GiB` | 2,048 x 128 KiB Markdown notes, 128 x 4 MiB attachments, 32 x 8 MiB exports |
| `incremental-pull-64MiB` | Same synchronized vault; update 128 notes, 8 attachments, 2 exports |
| `queued-push-1GiB` | Same bulk dataset, with local reconciliation completed before timing |
| `pull-notes-no-delay` | Pull 500 distinct 4 KiB Markdown notes |
| `pull-notes-page-40ms` | Same notes; 40 ms before each metadata request, 5 ms before each blob GET |
| `pull-notes-page-120ms` | Same notes; 120 ms before each metadata request, 5 ms before each blob GET |
| `push-mixed-no-delay` | 240 distinct 4 KiB notes and one 8 MiB attachment, attachment queued first |
| `push-mixed-latency` | Same mixed data; 40 ms before every upload and commit request |
| `push-mixed-slow-attachment` | Same delays plus 800 ms before the attachment upload |

Delays are independent asynchronous waits before actual requests. They model
scheduling conditions, not actual RTT or shared bandwidth. Responses, validation,
conflict policy, storage, and acknowledgements always come from the real server.
The old fake-server throughput results are not comparable baselines for this suite.

Fixtures are deterministic plaintext recipes generated outside timing, with sizes
and hashes recorded in a manifest. Every sample creates a fresh server and client
process with fresh storage. Seeding uses a separate real client; incremental local
state comes from a preceding real sync. Seed clients close before measurement.
Fixtures are generated in temporary storage, without persistent encrypted caches.
Allow several GiB of free disk space for `full`, plus workspace dependency installs
when comparing revisions. Server quotas are checked rather than bypassed.

## Timing and correctness

Authentication, connection setup, fixture generation, and push reconciliation are
outside timing. Automatic sync is deferred until the measured operation starts.
Timing includes `syncNow()`, draining pending/in-flight work, and checking completion
and cursor convergence. Preparation and verification durations are separate.
A false sync result, error, unexpected conflict, incomplete queue, or timeout fails
the sample. Each worker command has a five-minute deadline; disposal has a shorter
bounded deadline. Server readiness and migrations are separately bounded.

After timing, files are verified by path, count, size and SHA-256 hash, together with
cursor/pending state. Push verification uses an independent receiving client that
fetches and unwraps the key envelope. Verification never constructs an entire vault
snapshot in memory. Failure invalidates the sample even if the duration was fast.

The isolation policy is `fresh-process/prepared-session`: a rehearsal exercises the
path but does not imply warm JIT state in each fresh measured process. OS disk caches
are uncontrolled. This suite does not claim cold-disk or steady-state process timing.

## Metrics

All event timestamps are milliseconds since measurement started:

- `totalMs`: measured sync through drain/completion, including small RSS sampler overhead.
- `firstCommitAckMs`: first successful commit acknowledgement seen by the client.
  This differs from the old fake server's pre-ack `firstCommitMs`.
- `firstNoteAppliedMs`, `fileAppliedP95Ms`, `noteAppliedP95Ms`: unique local completion
  offsets from real client diagnostics. p95 is nearest-rank within a single run.
- `uploadCompletedMs`, `notesAppliedBeforeAttachmentUploadCompleted`: attachment HTTP
  completion and how many notes were applied before it, for mixed scenarios.
- `uploadRequests`, `uploadedBytes`, `downloadRequests`, `downloadedBytes`,
  `commitRequests`, `pageRequests`: attempted requests and encrypted body bytes,
  including retries, excluding headers. Response bytes include failed blob responses.
- `effectiveMiBPerSec`: logical changed MiB divided by measured duration, not network bandwidth.
- `initialRssBytes`, `peakSampledRssBytes`, `sampledRssIncreaseBytes`: whole-client
  process RSS sampled every 20 ms and at the end. Excludes separate server and seed
  processes; misses brief peaks and includes retained client runtime allocations.

The console/PR table reports run medians, candidate min/max and successful sample counts. Raw samples
allow inspecting spread; five runs do not justify a run-level p95. Per-file p95 is
not a run-level percentile. Missing events are null, not zero. Incomplete results
never get a percentage speedup. Negative duration change means faster.

## CI and maintenance

Use `@synch bench` on a PR for quick comparisons, or `@synch bench full` for all
workloads. Manual workflow dispatch selects quick/full and compares the selected
commit with its first parent. PR comparisons use the merge commit and its first
parent, fixing the exact base included in that merge. Each runtime compares both
revisions within one runner; base/candidate sample order alternates.

CI fails on execution, correctness, or invalid-report failures. Performance changes
are initially informational. Results remain separate for Node and Cloudflare, with
raw artifacts retained for 30 days. Publishing uses trusted default-branch code
with bounded artifact validation and a separate permission scope.

```sh
pnpm -C benchmarks/sync test
pnpm -C benchmarks/sync typecheck
pnpm -C benchmarks/sync test:lifecycle
pnpm -C packages/sync-testkit test
pnpm -C packages/sync-testkit typecheck
pnpm -C tests/sync-e2e test:e2e
```

Ordinary unit tests do not start benchmark servers. Keep E2E scenario assertions
under `tests/sync-e2e`; testkit owns only provisioning and real transport. Keep
workload recipes and measurements here. Two-device propagation, browser/Dexie,
deployed service measurements and distributed load testing are future tracks.
