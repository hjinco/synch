DROP INDEX `vault_sync_status_activity_idx`;--> statement-breakpoint
ALTER TABLE `vault_sync_status` DROP COLUMN `last_activity_at`;--> statement-breakpoint
ALTER TABLE `vault_sync_status` DROP COLUMN `last_flush_error`;--> statement-breakpoint
ALTER TABLE `vault_sync_status` DROP COLUMN `last_flush_error_at`;