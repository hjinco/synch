CREATE TABLE `invitation_vault` (
	`invitation_id` text NOT NULL,
	`vault_id` text NOT NULL,
	PRIMARY KEY(`invitation_id`, `vault_id`),
	FOREIGN KEY (`invitation_id`) REFERENCES `invitation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sharing_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sharing_audit_org_idx` ON `sharing_audit` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sharing_refresh` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vault_key_request` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`access_version` integer NOT NULL,
	`public_key` text NOT NULL,
	`status` text NOT NULL,
	`envelope_json` text,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vault_key_request_vault_status_idx` ON `vault_key_request` (`vault_id`,`status`);--> statement-breakpoint
CREATE INDEX `vault_key_request_user_idx` ON `vault_key_request` (`user_id`);--> statement-breakpoint
ALTER TABLE `vault` ADD `shared_at` integer;--> statement-breakpoint
ALTER TABLE `vault_membership` ADD `access_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `vault_membership` ADD `explicit_access` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `vault_membership` ADD `is_creator` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE vault_membership SET is_creator = (role = 'owner');
--> statement-breakpoint
ALTER TABLE `vault_membership` DROP COLUMN `role`;
--> statement-breakpoint
-- Preserve legacy shared-password access for existing active users before disabling
-- the unscoped wrapper fallback on shared vaults. No key is decrypted or rotated.
INSERT INTO vault_key_wrapper (id, vault_id, key_version, kind, user_id, envelope_json, created_at, revoked_at)
SELECT lower(hex(randomblob(16))), w.vault_id, w.key_version, 'password', m.user_id, w.envelope_json, w.created_at, NULL
FROM vault_key_wrapper w
JOIN vault v ON v.id = w.vault_id AND v.active_key_version = w.key_version
JOIN vault_membership m ON m.vault_id = w.vault_id AND m.status = 'active'
JOIN member om ON om.organization_id = v.organization_id AND om.user_id = m.user_id
WHERE w.kind = 'password' AND w.user_id IS NULL AND w.revoked_at IS NULL
AND w.id = (SELECT old.id FROM vault_key_wrapper old
  WHERE old.vault_id = w.vault_id AND old.kind = 'password' AND old.user_id IS NULL
    AND old.revoked_at IS NULL AND old.key_version = v.active_key_version
  ORDER BY old.created_at DESC, old.id DESC LIMIT 1)
ON CONFLICT (vault_id, kind, user_id) DO NOTHING;
--> statement-breakpoint
UPDATE vault SET shared_at = created_at
WHERE (SELECT count(*) FROM vault_membership m WHERE m.vault_id = vault.id AND m.status != 'revoked') > 1;
