# Synch API

The same application runs on Cloudflare Workers and self-hosted Node. Keep
business decisions shared; put platform-specific I/O and lifecycle behavior in
adapters and runtime entrypoints.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/index.ts`, `src/self-host.ts` | Cloudflare and Node entrypoints |
| `src/runtime/` | HTTP, WebSocket, queue, scheduled-task and shutdown lifecycles |
| `src/config/` | Environment parsing and deployment capabilities |
| `src/composition/` | Construct service graphs and connect adapters to application ports |
| `src/app.ts` | Register public HTTP routes and error mapping |
| `src/auth/` | Better Auth integration, sessions and sign-in policies |
| `src/vault/` | Vault catalog, password wrappers, retention and purge |
| `src/sharing/` | Organization membership, invitations, key setup and access revocation |
| `src/subscription/`, `src/billing/` | Entitlements and payment-provider integration |
| `src/sync-access/` | Issue and verify sync tokens |
| `src/sync-blob-transfer/` | Transfer encrypted objects and coordinate staging |
| `src/sync-coordinator/` | Per-vault mutations, history, sockets, maintenance and repair |
| `src/platform/` | Small shared transport utilities, email contracts and logging |
| `src/db/`, `drizzle/`, `drizzle-do/` | Database schemas and migrations |
| `web/` | Account and vault management UI; built into `public/` |

## Dependency boundaries

Feature `domain/` code holds policies and data rules. `application/` code orders
use cases and depends on persistence/transport contracts. `adapters/` implements
those contracts and translates HTTP, RPC, WebSocket, database and provider data.
Construct concrete implementations in `composition/`; use `runtime/` for platform
lifecycle concerns. Small features need not duplicate every directory level.

Application and domain code must not import HTTP handlers, database adapters,
runtime entrypoints, or framework/provider SDKs. Pure shared types, policies,
validation and logging can be reused. `test/unit/architecture.test.ts` checks
direct imports, re-exports and dynamic imports for these forbidden dependencies.
It runs with the normal unit suite. Cross-feature calls should use application
contracts or shared domain policies rather than reaching into another adapter.

### Sharing

`composition/features/create-sharing-feature.ts` selects the store and email
adapter. `sharing/application/service.ts` binds the public methods of these
focused services:

- `authorization.ts`: organization membership, manager privileges and key-setup access.
- `organization-service.ts`: organization views, names and member changes.
- `invitation-service.ts`: recipient checks, seat reservations and delivery cooldowns.
- `key-request-service.ts`: enrollment/recovery, approval and encrypted wrapper completion.
- `refresh.ts`: durable refresh retries and expired-request cleanup.

`SharingAccess` separately enforces active enrollment before sync token issuance.
Key setup may admit a pending member; sync must not. Preserve that distinction.
The server stores and transfers encrypted envelopes, never plaintext vault keys.
Membership and wrapper changes retain the store's conditional writes and batches.
Refresh completion must match the queued revision so it cannot erase newer work.

### Coordinator maintenance

`PersistentMaintenanceScheduler` owns durable job ordering, SQL, GC time buckets,
bounded draining and retry backoff for both runtimes. The Cloudflare adapter uses
Durable Object alarms; the Node adapter owns one process timer per vault. Runtime
code still owns request/alarm serialization and retries for failed alarm callbacks.
Node shutdown cancels the timer but leaves persisted jobs recoverable on restart.

The parity tests exercise both adapters against real SQLite. Preserve the early
return for an already-earlier job: scheduling from the mutation path should not
rewrite the same job or reset its alarm. See the
[coordinator guide](src/sync-coordinator/README.md) for transaction, blob accounting,
purge and repair invariants, and the [billing guide](src/billing/README.md) for
payment-provider boundaries.

## Validation

Run from the repository root, using `pnpm`:

```sh
pnpm -C apps/api test:unit
pnpm -C apps/api test:integration:cloudflare
pnpm -C apps/api test:e2e:node
pnpm -C apps/api typecheck
```

Run these sequentially: unit and Node E2E commands rebuild `public/`, which the
Cloudflare suite serves as assets. A concurrent rebuild can invalidate its files.
Cloudflare tests use `vitest.config.mts` and the local environment settings; see
[`.env.example`](.env.example). Node tests provision isolated local services.

For frontend changes also run `pnpm -C apps/api test:web`. Build the affected
deployment targets when changing runtime wiring:

```sh
pnpm -C apps/api build:node
pnpm -C apps/api build:cloudflare:community
pnpm -C apps/api build:cloudflare:managed
```

Cloudflare build commands are dry runs. For changes likely to affect sync speed,
follow the [sync benchmark guide](../../benchmarks/sync/README.md) and compare the
working tree against the baseline sequentially on an otherwise idle machine.
