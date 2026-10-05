# Next Obsidian plugin release

## Added

## Changed

- Show subscription settings only to organization owners and vault management only to organization owners and admins, while preserving vault management on older self-hosted servers.

## Fixed

- Recover files stuck on an outdated sync revision without overwriting newer vault settings, and back off when a conflict cannot be resolved, preserving pending changes instead of repeatedly sending the same requests.
- Show loading spinners on vault sharing and connection buttons while requests are processing.
- Confirm successful vault access approvals with a notification naming the recipient and vault.
- Prevent outdated subscription status from reappearing after signing out or resetting the status.
