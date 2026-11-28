# Next Obsidian plugin release

## Added

- Sync diagnostics keep the latest 1,000 events on this device across restarts, including file transfer stages and sizes.

## Changed

- The Upgrade button opens a page for choosing a paid plan for the selected organization.
- Sync reads each downloaded attachment buffer once and releases its reference to encrypted attachments earlier.

## Fixed

- Excluding a file type or folder on this device now skips uploads and downloads, keeps existing copies in place, and resumes sync under your conflict policy when you include it again.
- Sync preserves edits made while a Markdown merge is being saved. When a download or merge is interrupted, sync checks for a partial write before scanning for new edits or deletions.
- When Obsidian cannot distinguish two files by their decoded text, sync keeps the latest bytes at the original path and saves the merged note as a conflict copy.
- When two remote files move to the same settings path, sync now honors the conflict-copy policy for local edits to the original note.
- Sync can apply a batch of remote changes even when many local edits are still waiting for Obsidian to report them.
- Downloaded and merged Markdown preserves UTF-8 byte order marks and Unicode line separators.
- Renaming a note on another device preserves the file when only the capitalization changes. Retrying an interrupted rename also avoids creating a duplicate conflict copy.
- Sync keeps a renamed note’s version history when recovering an interrupted merge.
- Sync preserves pending edits and tracks both file versions when local and remote changes to the same file overlap.
