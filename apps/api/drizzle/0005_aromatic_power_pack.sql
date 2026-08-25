ALTER TABLE `account` ADD `issuer` text DEFAULT 'local:credential' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_uidx` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_deviceCode_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_userCode_uidx` ON `device_code` (`user_code`);