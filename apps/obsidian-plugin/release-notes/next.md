# Next Obsidian plugin release

## Added

- Editor presence: see each collaborator's colored selection and cursor, with their name above the cursor, when they have the same note open.

## Changed

- Text fields now submit remote-vault actions and self-hosted server URL changes when you press Enter.
- Local changes now begin syncing sooner after Obsidian saves them.
- Syncing and reconnecting now show a static loader icon in the status bar, without a spinning animation. The settings spinner is unchanged.
- The status bar and sync settings now use the same sync status wording.

## Fixed

- Store vault credentials separately for each Obsidian vault and automatically migrate existing credentials to vault-scoped storage.
- Show a clear “more storage is needed” state in the status bar and sync settings after a vault reaches its storage quota.
- Reduce memory retained while uploading files to improve stability for vaults with large attachments.
