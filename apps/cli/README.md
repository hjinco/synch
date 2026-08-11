# @synch/cli

Headless CLI for Synch, the end-to-end encrypted Obsidian Sync alternative. It
drives `@synch/sync-client` with Node host adapters so a vault directory can be
synchronized from servers, containers, or scripts without Obsidian.

Requires Node.js >= 22.5 (`node:sqlite`, global `fetch`/`WebSocket`/WebCrypto).

## Commands

```sh
synch login                          # device-code sign-in (prints URL + code)
synch logout                         # sign out, clear stored keys
synch vault connect --vault-id <id>  # unlock a remote vault for a directory
synch sync                           # one-shot synchronization
synch watch                          # keep syncing until interrupted
synch status                         # account, vault, and sync state
```

Common options: `--vault <path>` (default: current directory) and
`--api-url <url>` (or the `SYNCH_API_URL` environment variable).

## State layout

- `<vault>/.synch/sync.sqlite` — local sync store (`node:sqlite`), never synced.
- `<vault>/.synch/cli.lock` — exclusive per-vault process lock with stale-lock
  recovery.
- `~/.config/synch/credentials.json` (XDG-aware, `chmod 600`) — session token
  and per-vault remote vault keys, stored outside the vault.

## Development

```sh
pnpm -C apps/cli dev -- status       # run from sources via tsx
pnpm -C apps/cli test                # vitest
pnpm -C apps/cli typecheck           # tsgo
pnpm -C apps/cli build               # bundle to dist/synch.js
```
