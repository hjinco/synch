# sync-client benchmarks

These are black-box benchmarks for the public `SyncEngine` façade. The fake
server, vault and store provide a deterministic environment; benchmark setup
and correctness verification are kept outside the timed operation.

The fixture is a persistent 1 GiB dataset: 2,048 Markdown notes, 128 4 MiB
attachments and 32 8 MiB exports. The first run creates encrypted fixture files
under `packages/sync-client/benchmarks/fixtures/1gb`; later runs load and reuse
the existing files after validating `manifest.json`. To use another generated
fixture location, set `SYNCH_SYNC_CLIENT_FIXTURE_DIR`.

Run them with:

```sh
pnpm -C packages/sync-client bench
```

To save a result for a later comparison, pass Vitest's JSON output option:

```sh
pnpm -C packages/sync-client exec vitest bench \
  --config vitest.bench.config.mts \
  --outputJson /tmp/sync-client-baseline.json
```

The scenarios cover initial pull of 1 GiB, incremental pull of 64 MiB changed
files, and push of 1 GiB of pending local files. Keep the fixture manifest,
scenario setup, and fake transport behavior stable when comparing baselines.

To run it on a pull request, add this comment:

```text
@synch bench
```

The GitHub Actions workflow creates a fresh fixture on each requested run and
updates a dedicated benchmark comment on the PR. It checks out the PR merge
ref, so the result includes the current PR changes.

To compare the current worktree with `origin/main` locally, use:

```sh
pnpm bench:sync-client:compare
```

An alternative base ref can be passed as the first argument. The helper uses a
temporary worktree and fresh temporary fixtures for both runs, then lets
Vitest print the current result alongside the base result.

## Mixed push latency scenarios

Run only the lightweight mixed scenarios (no 1 GiB fixture is generated):

```sh
SYNCH_SYNC_CLIENT_METRICS_PATH=/tmp/synch-push-metrics.json \
  pnpm -C packages/sync-client bench --run -t push-mixed
```

`mixed-push-fixture.ts` defines the file sizes, content, expected hashes, and
attachment-first queue order. Each run creates 240 distinct 4 KiB Markdown notes
and one 8 MiB binary attachment in a temporary filesystem vault. The benchmark
file defines transport delays and handles execution, measurement, and verification.
Reconciliation and session setup are outside the timed operation. Queue timestamps explicitly place the
attachment first, followed by notes in path order, independently of generated
entry IDs. All three profiles use the same content and ordering:

| Scenario | Delay per upload | Delay per commit request | Extra attachment upload delay |
| --- | ---: | ---: | ---: |
| `push-mixed-no-delay` | 0 ms | 0 ms | 0 ms |
| `push-mixed-latency` | 40 ms | 40 ms | 0 ms |
| `push-mixed-slow-attachment` | 40 ms | 40 ms | 800 ms |

Delays are asynchronous, per request, and additive to local filesystem work.
Concurrent uploads wait independently: this models request latency and a
straggler, **not** shared bandwidth, an actual RTT distribution, or Cloudflare
execution/storage costs. The fake server's commit delay precedes applying the
mutations and returning the acknowledgement. Production sync code is unchanged.

Every measured run is verified after timing: the pending queue must be empty,
the cursor must match, all files must have completion observations, and every
remote blob must decrypt to the expected size and content hash. No performance
threshold is asserted. In particular, the current implementation may report
zero notes applied before the attachment finishes; future pipeline changes
should improve this observation without changing the scenario.

### Measurements

Vitest still reports total `syncNow()` duration, with one warmup and five measured
iterations. The console also shows a compact timing summary. The optional JSON
file stores environment, fixture/profile parameters, and raw **measured** samples;
warmup, setup, verification, and cleanup are excluded. Its parent directory must
already exist. Keep it separate from Vitest's `--outputJson` result file.

All event times are milliseconds since the timed run started, rather than
per-file service times:

- `totalMs`: observed `syncNow()` duration, including the small RSS sampler setup
  overhead; final RSS sampling occurs after the duration is recorded.
- `firstCommitMs`: first mutation batch applied by the fake server, before the
  acknowledgement reaches the client.
- `firstNoteAppliedMs`: first Markdown completion reported by the real client,
  after local acceptance has been persisted to the benchmark store.
- `fileAppliedP95Ms` / `noteAppliedP95Ms`: nearest-rank p95 across unique file
  completions within that run. The console averages these per-run p95s; it does
  not pool all files across runs.
- `notesAppliedBeforeSlowUpload`: number of notes completed locally before the
  attachment upload finished. The attachment is observed in all three profiles,
  including those without extra delay.
- `slowUploadCompletedMs`: attachment upload completion time.
- `uploadRequests` / `uploadedBytes`: PUT attempts and encrypted request-body
  bytes, excluding HTTP headers; retries would count again.
- `commitRequests`: commit batch requests sent to the fake server.
- `initialRssBytes` / `peakSampledRssBytes` / `sampledRssIncreaseBytes`: process RSS
  at start, maximum sampled RSS, and the difference. Sampling occurs every 20 ms
  and at the end. These are **process-wide sampled observations**, not an exact
  peak or per-engine allocation total. They include the runtime, other prepared
  runs and retained allocations, and can miss short spikes. Use isolated scenario
  runs and the same environment when comparing memory; do not interpret a zero
  increase as zero allocation.

The new scenarios complement the existing 1 GiB client throughput benchmark.
They do not replace real-server measurements for protocol or server changes,
nor do they model Obsidian's Dexie persistence or mobile runtime. Retry scenarios
and a deterministic pipeline ordering test belong with the corresponding future
implementation work; this change establishes the current timing baseline.
