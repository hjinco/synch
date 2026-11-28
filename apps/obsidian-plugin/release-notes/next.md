# Next Obsidian plugin release

## Added

- Sync diagnostics keep the latest 1,000 events on this device across restarts, including file transfer stages and sizes.

## Changed

- The Upgrade button opens a page for choosing a paid plan for the selected organization.
- Sync reads each downloaded attachment buffer once and releases its reference to encrypted attachments earlier.

## Fixed

- Excluding a file type or folder on this device now skips uploads and downloads, keeps existing copies in place, and resumes sync under your conflict policy when you include it again.
