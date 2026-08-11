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

The future headless CLI should keep process locking and credential persistence
in its Node host layer. It must acquire an exclusive lock for a vault before
opening its sync store or starting file watching, and it must not persist the
remote vault key through this package. The reserved `.synch` path is excluded
from synchronization and is suitable for non-secret, vault-local CLI state;
credentials should live outside the vault or in an encrypted host-managed
store.
