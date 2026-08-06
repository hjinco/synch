ALTER TABLE `coordinator_state` ADD `sync_paused_at` integer;--> statement-breakpoint
ALTER TABLE `coordinator_state` ADD `sync_pause_reason` text;