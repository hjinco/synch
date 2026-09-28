CREATE TABLE `sync_access_revocations` (
	`key` text PRIMARY KEY NOT NULL,
	`minimum_version` integer,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
DELETE FROM `maintenance_jobs` WHERE `key` = 'sharing_access';
