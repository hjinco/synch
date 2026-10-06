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
synch pull                           # download only; never upload local changes
synch sync                           # one-shot synchronization
synch watch                          # keep syncing until interrupted or stopped by a terminal sync error
synch status                         # account, vault, and sync state
```

`synch pull` never scans for local changes and never uploads pending local
mutations. Remote versions replace differing files in the target directory, so
use it only for read-only replicas or backup staging directories.

Common options: `--vault <path>` (default: current directory) and
`--api-url <url>` (or the `SYNCH_API_URL` environment variable). The API URL
is saved with the session token after a successful login. Subsequent commands
use `--api-url`, then `SYNCH_API_URL`, then the saved login URL, then the default
`http://127.0.0.1:8787`, in that order. A token saved for another API URL is not
sent to an overridden server; log in again to replace the single saved login.
Existing credentials without an API URL retain the previous resolution behavior;
the URL is saved after their session is successfully verified. Logout clears
both the token and its URL.

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
