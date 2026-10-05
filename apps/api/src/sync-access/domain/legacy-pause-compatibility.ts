/**
 * TODO(remove-legacy-pause-quota): Remove after affected manually updated clients
 * handle sync_paused by disabling auto sync themselves. Until then, allow
 * authenticated token/socket/read access so a paused client can reach a blob
 * upload, where sync_paused is translated to HTTP 413 quota_exceeded. Old
 * plugins persist syncEnabled=false only for that upload response and show a
 * misleading storage-quota notice. Read-only/idle clients will NOT be stopped.
 * Never relax vault authorization or paused-vault mutation/staging guards.
 * Set false to restore normal pause admission and upload error behavior.
 */
export const LEGACY_PAUSE_QUOTA_COMPATIBILITY = true;
