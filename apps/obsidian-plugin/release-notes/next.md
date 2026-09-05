# Next Obsidian plugin release

## Added

- Add an Obsidian return link after device sign-in approval on supported plugin versions.

## Changed

- Reduce waiting between batches when downloading large remote vaults.

- Keep uploading queued files while slower attachments finish, and prioritize incoming remote changes after active uploads settle.

- Open self-hosted device sign-in pages through an external browser when they use localhost.

## Fixed

- Reduce memory retained during large remote vault syncs by applying changes in smaller batches.
- Keep sync progress consistent while files change during sync, and show completed counts until the total is known.
