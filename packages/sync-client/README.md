# `@synch/sync-client`

Platform-independent client primitives for Synch. This package owns the
end-to-end encryption model, sync protocol, reconciliation and push/pull
services, realtime loop, storage contracts, vault filesystem contracts,
session managers (auth / remote vault), billing status client, shared
sync status helpers, and the host-agnostic SyncEngine façade.

It deliberately does not depend on Obsidian, Dexie, Node.js filesystem APIs,
or an operating-system credential store. A host application supplies those
capabilities through the exported ports:

- `HttpClient` and `WebSocketFactory` for network access.
- `SyncStore` for durable local sync state.
- `SyncVaultAdapter` for scanning and safely changing vault files.
- `SyncVaultConfigSource` and `SyncChangeSource` for config listing and
  local change watching.
- Authentication tokens and the in-memory remote vault key.
- Credential persistence for auth session tokens and vault key bytes
  (session managers live here; persistence stays in the host).

The Obsidian host keeps its Dexie, `requestUrl`, vault event, SecretStorage,
and UI adapters under `apps/obsidian-plugin`.

The headless CLI keeps process locking and credential persistence
in its Node host layer. It must acquire an exclusive lock for a vault before
opening its sync store or starting file watching, and it must not persist the
remote vault key through this package. The reserved `.synch` path is excluded
from synchronization and is suitable for non-secret, vault-local CLI state;
credentials should live outside the vault or in an encrypted host-managed
store.

Host applications import from explicit package entry points; paths under
`src/sync` are implementation details and are not exported:

| Entry point | Purpose |
| --- | --- |
| `@synch/sync-client/engine` | SyncEngine, change/config source ports, progress and history result types |
| `@synch/sync-client/core` | Content runtime, crypto, file/config rules and presence types |
| `@synch/sync-client/store` | Durable sync store contracts and row types |
| `@synch/sync-client/store/entry-record` | Shared persistence records and transitions for store adapters |
| `@synch/sync-client/vault` | Vault filesystem ports and safe write helpers |
| `@synch/sync-client/remote` | Remote vault management, sync access tokens and host-facing protocol types |
| `@synch/sync-client/auth` | Authentication client, session manager and token storage port |
| `@synch/sync-client/billing` | Billing status client |
| `@synch/sync-client/http` | HTTP port and network status helpers |
| `@synch/sync-client/diagnostics` | Diagnostic events, in-memory collection and formatting |
| `@synch/sync-client/testing` | In-memory store and vault adapters for host tests |

The package root re-exports the application entry points. Adapter persistence
helpers and test utilities remain separate opt-in imports.

`SyncEngine` creates one `SyncContentRuntime` and disposes it with the engine.
If the host supplies a runtime, the host owns its disposal. Internal services
borrow a required runtime; standalone service tests supply and dispose one
explicitly. HTTP blob uploads and downloads share one authorized client,
which owns API URL resolution and token refresh.
