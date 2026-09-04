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
