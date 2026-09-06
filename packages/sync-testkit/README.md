# Sync testkit

Private development-only provisioning and real transport shared by sync E2E and
system benchmarks. Production packages must not import this package.

- `@synch/sync-testkit/server`: `startServer(runtime, checkoutRoot?)`, returning an
  isolated server URL, bounded diagnostic log and an async cleanup handle.
- `@synch/sync-testkit/account`: signup and public vault provisioning, password
  wrapping/unlocking, and token requests. `attachVault` reconstructs a client-side
  handle for another local process; it does not create or modify a remote vault.
- `@synch/sync-testkit/transport`: real HTTP/WebSocket with optional observation
  and delay hooks. By default no bodies are copied, retained or decoded as text
  for successful blob requests. `close()` aborts HTTP and terminates owned sockets.

E2E opts into capture/corruption in its own network wrapper. Benchmarks keep only
bounded counters and completion timestamps. This package owns no fake server
policy, fixture catalog, test assertions, performance statistics or scenario runner.
Node clients and loopback servers are supported on the macOS/Linux development and
CI environments; process-group cleanup is used there. Windows is not a validated
server lifecycle environment.
