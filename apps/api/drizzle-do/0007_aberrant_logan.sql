ALTER TABLE `coordinator_state` DROP COLUMN `health_summary_dirty`;--> statement-breakpoint
ALTER TABLE `coordinator_state` DROP COLUMN `last_activity_at`;--> statement-breakpoint
ALTER TABLE `coordinator_state` DROP COLUMN `last_health_flushed_at`;--> statement-breakpoint
ALTER TABLE `coordinator_state` DROP COLUMN `health_flush_retry_count`;--> statement-breakpoint
ALTER TABLE `coordinator_state` DROP COLUMN `last_health_flush_error`;--> statement-breakpoint
ALTER TABLE `coordinator_state` DROP COLUMN `last_health_flush_error_at`;