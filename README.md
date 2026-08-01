# Synch

Synch is an Obsidian Sync alternative for end-to-end encrypted vault synchronization.

Synch is an independent community plugin and service. It is not affiliated with
Obsidian.

Website: [https://synch.run](https://synch.run)

Translations: [한국어](docs/i18n/README.ko.md) ·
[日本語](docs/i18n/README.ja.md) ·
[简体中文](docs/i18n/README.zh-CN.md) ·
[繁體中文](docs/i18n/README.zh-TW.md)

## Install

1. In Obsidian, open **Settings** → **Community plugins**.
2. Turn off Restricted mode, then select **Browse**.
3. Search for **Synchrun**, select it, and choose **Install**.
4. Enable **Synchrun** after installation finishes.

## Features

- **Near-instant sync:** Synch checks for changes frequently so edits can move
  between devices almost immediately.
- **Version history:** Recover from accidental edits with encrypted history for
  synced files.
- **Deleted file recovery:** Bring back deleted notes and attachments while
  they are still kept in version history.
- **Automatic conflict merges:** When the same Markdown note changes on
  multiple devices, Synch automatically combines edits made to different
  parts. If edits overlap, it creates a conflict file so no content is lost.

## How to use Synch

1. Install and enable the plugin.
2. Open Synch's settings in Obsidian.
3. Sign in to a Synch account from the plugin.
4. Create or connect a remote vault.
5. Keep Obsidian open while Synch uploads local changes and downloads remote changes.

Synch syncs Markdown files by default. Images, audio, videos, and PDFs are also
enabled by default. Other file types are disabled by default and can be enabled
from the plugin settings. Hidden folders and hidden files are skipped, and you
can exclude additional folders in settings.

When the same path is changed in incompatible ways on different devices, Synch
keeps the conflicting content by writing a conflict copy in the vault instead of
silently discarding it.

The plugin can use the hosted Synch Cloud API or a custom API base URL for a
self-hosted deployment.

## Self-hosting

You can run your own Synch server on a free Cloudflare account and connect the
Obsidian plugin to it with a custom server URL.

See the self-hosting guide:
[https://synch.run/self-hosting](https://synch.run/self-hosting)

## Disclosures

This section is provided for Obsidian developer policy review and for users who
want to understand what the plugin does before installing it.

### Account requirements

Synch requires a Synch account to use the hosted sync service. The account is
used to authenticate devices, create and connect remote vaults, issue sync
tokens, enforce storage limits, and manage service access.

### Network use

Synch connects to the configured Synch API base URL over HTTPS and WebSocket
connections. For the hosted service, this is Synch-operated infrastructure. The
default hosted API endpoint is `https://api.synch.run`, and realtime sync uses
`wss://api.synch.run` WebSocket connections. The plugin uses network requests
to:

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
timestamps, sync cursors, session information, IP addresses, User-Agent strings,
billing identifiers for hosted subscriptions, and similar operational metadata.

### Local vault access

Synch reads and writes files inside the current Obsidian vault so it can sync
selected vault files. It stores plugin settings with Obsidian's plugin data API,
stores the device session token with Obsidian's secret storage API, and stores
local sync state in browser IndexedDB.

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

### Source code

Synch is open source under the MIT License. The source code for the plugin,
hosted API, and website is published in this repository.
