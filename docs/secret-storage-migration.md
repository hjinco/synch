# Vault-scoped secret storage

## Context

The Obsidian plugin previously stored the remote vault key and device session
token under fixed secret names. When multiple vaults used the same Obsidian
installation, a fixed name did not make the intended vault relationship
explicit and could allow one vault's credential to be read while another vault
was active.

The plugin now namespaces both credentials with a stable identifier belonging
to the current Obsidian vault.

## Storage model

On first access, the plugin creates a UUID and stores it in Obsidian's
vault-local plugin storage as `synch.secretScopeId`. The UUID is only a
namespace identifier; it is not the remote vault key or the session token.

Scoped secret names are:

```text
synch-remote-vault-key-<secretScopeId>
synch-session-token-<secretScopeId>
```

The scope ID survives plugin reloads, application restarts, and sync-store
resets. It is intentionally separate from `synch.localVaultId`, which is
cleared when local sync state is reset. The scope ID and the secrets are stored
locally by Obsidian; they are not synced as vault files or sent to the Synch
server.

## Legacy migration

The old fixed-name secrets remain readable only during the plugin's startup
migration:

1. Initialize the plugin data store.
2. If the scoped value is absent, copy the legacy value into the scoped name.
3. After the scoped value is written successfully, clear the legacy secret.
4. Read credentials from the scoped names for the remainder of the session.

Session tokens and remote vault keys are migrated before authentication,
connection loading, or readiness checks. Migration copies the value and then
clears the old fixed-name secret.

New writes and clears use the scoped secret and clear the old fixed-name
secret. Errors encountered while reading or migrating are treated as missing
credentials so an unusual storage failure does not crash plugin startup or
make the plugin continue with an uncertain key.

## Non-goals

This change is local secret namespacing. It does not:

- repair existing server data that was encrypted with the wrong key;
- rotate vault keys or re-encrypt pending mutations.

If copying the value fails before the scoped secret is written, the legacy
value is left in place so a later startup can retry the migration.

If Obsidian's vault-local plugin storage is removed, the scope ID is lost and a
new one is generated. The existing scoped credentials may then require the
user to sign in or reconnect the remote vault again.

## Implementation

- Scope management: `apps/obsidian-plugin/src/adapters/secret-scope.ts`
- Remote vault key storage: `apps/obsidian-plugin/src/adapters/remote-vault-device-storage.ts`
- Session token storage: `apps/obsidian-plugin/src/adapters/auth-session-storage.ts`
- Startup migration and scoped-only reads: `apps/obsidian-plugin/src/app/plugin-controller.ts` and `apps/obsidian-plugin/src/app/session-store.ts`
- Regression coverage: `apps/obsidian-plugin/src/adapters/secret-storage.test.ts`
