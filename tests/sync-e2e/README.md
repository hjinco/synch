# Encrypted sync E2E

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm -C tests/sync-e2e test:e2e
SYNC_E2E_RUNTIME=node pnpm -C tests/sync-e2e test:e2e
SYNC_E2E_RUNTIME=cloudflare pnpm -C tests/sync-e2e test:e2e
pnpm -C tests/sync-e2e typecheck
```

Requires Node 24 and permission to listen on loopback ports. No deployed service,
Cloudflare credentials, Obsidian installation, or local `.env` is needed.

## Scope

The same scenarios use real `SyncEngine`, event recording, encryption, HTTP and
WebSocket clients against either the production Node entry point (SQLite/libSQL
and disk blobs) or Wrangler's local Cloudflare runtime (workerd, D1, Durable
Objects and R2). Cloudflare bindings are derived from the production community
configuration with isolated local storage and test-only secrets. Managed billing,
email and subscription policy remain covered by the existing API integration tests.
These tests do not exercise Cloudflare's deployed network or Obsidian UI/Dexie.

Every test gets a fresh remote vault and independent in-memory client stores.
Vault keys are password wrapped using production crypto. The second device fetches
the wrapper from the server and unlocks it independently. Downloaded ciphertext is
compared with uploaded ciphertext and checked for fixture plaintext leakage; this
is a regression check, not a general proof that all server storage/logs are secret-free.

## Conflict contracts

- Independent text changes merge and converge without conflict copies.
- Overlapping text and binary changes preserve the remote file and a local conflict copy.
- Identical edits clear pending work without producing copies.
- Different new files at one path preserve both contents.
- Delete first, edit second: deletion remains canonical and the edit survives in a local copy.
- Edit first, delete second: the pending deletion yields to the remote edit.
- Rename versus edit: the first committed path/content stays canonical; the losing
  local content survives in a conflict copy. Both orders preserve the entry identity.
- A transport barrier holds an actual outgoing commit while the other device commits.
  The real server must reject the stale revision, and the engine must pull, rebase,
  re-encrypt and commit successfully.

Conflict copies are intentionally excluded from sync by the existing file policy.
Tests therefore assert canonical convergence and preservation on the conflicting
device separately. Repeated sync and reconnect must not add copies or pending work.
Wrong keys and modified blob responses must preserve the local file and pull cursor;
restoring the key/transport must allow the same update to complete.

## Execution and diagnostics

`sync-e2e.yml` is a reusable workflow that runs both runtimes. API deployment
(`api-deploy.yml`) and Obsidian plugin release (`release-obsidian-plugin.yml`)
both require it to succeed before their deployment or release job can start,
including version bumps and tag creation. It can also be run independently with
`workflow_dispatch`, without deploying or releasing anything.

There are no PR/push triggers and no `test` script, so recursive unit-test commands
in ordinary CI do not run this suite. The suite tests client and server code from
the same checkout; compatibility with older deployed servers is outside its scope.

On failure, the suite prints each device's files, pending mutations, cursor,
errors, sync diagnostics and the local server log. All data and credentials are
synthetic. Servers and temporary storage are removed during teardown.

The network helper only delays actual messages or corrupts actual blob responses
for explicit failure tests. It never fabricates successful server responses or
implements server conflict policy. Scenario ordering uses completion conditions,
not timing sleeps; the server readiness probe polls the health endpoint.
