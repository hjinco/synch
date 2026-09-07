# Next Obsidian plugin release

## Added

## Changed

- Require encrypted sync and conflict recovery checks before publishing plugin releases.
- Reduce repeated encryption work when retrying uploads after an interrupted sync.
- Show a clear "checking for changes" status while the vault is being reconciled.

## Fixed

- Preserve the original HTTP error when an upload fails with an empty or non-JSON response.
- Keep the vault connected when the server temporarily pauses sync for repair.
