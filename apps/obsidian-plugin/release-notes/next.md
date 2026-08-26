# Next Obsidian plugin release

## Added

- On desktop, quitting Obsidian now waits briefly when a sync is already in progress so it can finish, including a file you just saved, instead of dropping the connection immediately.

## Changed

- Removed the obsolete remote vault format upgrade guidance now that all remote vaults use the current sync format.

## Fixed

- Improved sync retry handling so completed file uploads are cleaned up after a successful commit, reducing stale retry state during long-running sync sessions.
