<h1 align="center">Synch</h1>

<p align="center">End-to-end encrypted sync for Obsidian.</p>

<p align="center">
  <a href="https://synch.run">Website</a> ·
  <a href="https://synch.run/self-hosting">Cloudflare deployment</a> ·
  <a href="https://synch.run/self-hosting-docker">Docker deployment</a>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=synch"><img alt="Obsidian Community Plugin" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="docs/i18n/README.ko.md">한국어</a> |
  <a href="docs/i18n/README.ja.md">日本語</a> |
  <a href="docs/i18n/README.zh-CN.md">简体中文</a> |
  <a href="docs/i18n/README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://synch.run"><img alt="Synch overview" src=".github/assets/synch-preview.webp" /></a>
</p>

---

Keep your Obsidian vault in sync across devices with local encryption, version
history, and conflict-safe file handling.

Synch is an independent community plugin and service. It is not affiliated with
Obsidian.

## Why Synch?

- **Private by design** — Vault data is encrypted on your device before upload.
- **Fast sync** — Changes are detected frequently and synced across devices.
- **Recoverable** — Restore previous versions and deleted files from encrypted history.
- **Conflict-safe** — Non-overlapping Markdown edits can be merged automatically.
- **Your choice of hosting** — Use Synch Cloud or run your own Synch server.

## How it works

```mermaid
flowchart LR
    device["Your device"] --> encrypt["Encrypt vault data locally"]
    encrypt --> server["Synch Cloud or your self-hosted server"]
    server --> other["Download and decrypt on another device"]
```

The sync service stores encrypted file blobs and encrypted sync metadata. It is
designed so that the hosted service cannot read your plaintext notes, plaintext
file paths, or vault keys.

## Compare Obsidian sync options

Every option has a different balance of convenience, control, and setup effort.

| Option | Encryption | Storage model | Conflict handling | Best fit |
| --- | --- | --- | --- | --- |
| **Synch** | Device-side E2EE | Synch Cloud or self-hosted | Automatically merges non-overlapping Markdown edits; preserves overlapping conflicts | Users who want a simple, open-source, privacy-focused workflow |
| [Obsidian Sync](https://obsidian.md/sync) | E2EE by default; standard encryption is also available | Obsidian-hosted | Official Obsidian integration and sync history | Users who prefer the official hosted service |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | E2EE | Self-hosted CouchDB, object storage, or optional WebRTC | Automatically merges simple conflicts | Users who want maximum backend control |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | Optional password-based E2EE | Your S3, WebDAV, Dropbox, OneDrive, Google Drive, and other storage | Basic conflict detection; advanced smart conflict handling is available in Pro | Users who already have a preferred storage provider |

This comparison is intentionally high-level. Check each project's current
documentation and settings before migrating an important vault.

## Features

- Near-instant synchronization
- Encrypted version history
- Deleted file recovery
- Automatic Markdown conflict merging
- Conflict copies when edits overlap
- Markdown files enabled by default
- Images, audio, video, and PDF files enabled by default
- Additional file and folder exclusions
- Hosted Synch Cloud
- Custom API URLs for self-hosted deployments
- Desktop and mobile Obsidian support

## Get started

### Synch Cloud

1. Open **Settings → Community plugins** in Obsidian.
2. Turn off Restricted mode and select **Browse**.
3. Search for **Synchrun**.
4. Install and enable the plugin.
5. Open Synchrun's settings and sign in.
6. Create or connect a remote vault.

Once connected, keep Obsidian open while Synch uploads local changes and
downloads remote changes.

### Self-hosted Synch

The Cloudflare deployment guide deploys Synch to your own Cloudflare account. For
a non-Cloudflare deployment, use the Docker/systemd guide.

You can run Synch on:

- Cloudflare
- Docker
- Your own hardware with systemd

See the deployment guides:

- [Cloudflare deployment](https://synch.run/self-hosting)
- [Docker/systemd deployment](https://synch.run/self-hosting-docker)

After deployment, set the custom API base URL in the plugin settings.

## Safety notes

Always create a full backup of your vault before:

- Installing a new synchronization provider
- Migrating from another sync solution
- Changing encryption settings
- Resetting or reconnecting a remote vault

Do not run multiple synchronization providers against the same vault unless you
fully understand how their file watchers and conflict resolution interact.

### Disclosures

<details>
<summary>Show disclosures</summary>

This section is provided for Obsidian developer policy review and for users who
want to understand what the plugin does before installing it.

### Account requirements

Synch requires a Synch account to use the hosted sync service. The account is
used to authenticate devices, create and connect remote vaults, issue sync
tokens, enforce storage limits, and manage service access.

### Network use

Synch connects to the configured Synch API base URL over HTTPS and WebSocket
connections. For the hosted service, this is Synch-operated infrastructure.
The default hosted API endpoint is `https://api.synch.run`, and realtime sync
uses `wss://api.synch.run` WebSocket connections. The plugin uses network
requests to:

- Sign in and maintain an authenticated device session.
- Create, list, and connect remote vaults.
- Upload encrypted file blobs and encrypted sync metadata.
- Download encrypted file blobs and encrypted sync metadata.
- Exchange realtime sync messages over WebSocket connections.
- Read account, billing, quota, storage, and sync status.

Synch-hosted infrastructure uses third-party providers, including Cloudflare for
hosting, storage, networking, databases, queues, and related infrastructure.
Billing is handled by Polar.

### Data sent to Synch

Vault file contents and file path metadata are encrypted on your device before
they are uploaded. Synch stores encrypted blobs and encrypted sync metadata and
is designed so that the hosted service cannot read your plaintext notes,
plaintext file paths, or plaintext vault keys.

End-to-end encryption does not hide all operational metadata. Synch may process
account information, vault identifiers and names, organization and membership
records, local vault identifiers, blob identifiers, file sizes, storage usage,
timestamps, sync cursors, session information, IP addresses, User-Agent
strings, billing identifiers for hosted subscriptions, and similar operational
metadata.

### Local vault access

Synch reads and writes files inside the current Obsidian vault so it can sync
selected vault files. It stores plugin settings with Obsidian's plugin data
API, stores the device session token with Obsidian's secret storage API, and
stores local sync state in browser IndexedDB.

Synch does not intentionally read or write files outside the current Obsidian
vault.

### Payments

The hosted service offers free and paid subscription plans. The current paid
hosted plan is Sync Starter, available with monthly or annual billing. Payment
processing and subscription management are handled by Polar.

### Telemetry, ads, and privacy

The Synch Obsidian plugin does not include client-side telemetry and does not
show ads. The hosted service may process operational logs and service metadata
needed to run, secure, troubleshoot, and improve the service.

For details, read the hosted service legal documents:

- [Privacy Policy](https://synch.run/privacy)
- [Terms of Service](https://synch.run/terms)

</details>

## Contributing

Issues, bug reports, documentation improvements, and pull requests are
welcome.

## License

Synch is open source under the [MIT License](LICENSE).
