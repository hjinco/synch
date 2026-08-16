import { relations, sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { organization, user } from "./auth-schema";
import type { VaultKeyEnvelope } from "../../vault/types";

export const vault = sqliteTable("vault", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	activeKeyVersion: integer("active_key_version").notNull(),
	syncFormatVersion: integer("sync_format_version").notNull().default(2),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.defaultNow()
		.notNull(),
	deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
	purgeStatus: text("purge_status"),
	purgeError: text("purge_error"),
}, (table) => [
	index("vault_organizationId_idx").on(table.organizationId),
	index("vault_deletedAt_idx").on(table.deletedAt),
	uniqueIndex("vault_organization_name_active_uidx")
		.on(table.organizationId, table.name)
		.where(sql`${table.deletedAt} is null`),
]);

export const vaultMembership = sqliteTable(
	"vault_membership",
	{
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		status: text("status").notNull(),
		joinedAt: integer("joined_at", { mode: "timestamp_ms" })
			.defaultNow()
			.notNull(),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		primaryKey({ columns: [table.vaultId, table.userId] }),
		index("vault_membership_userId_status_idx").on(table.userId, table.status),
		index("vault_membership_vaultId_status_idx").on(table.vaultId, table.status),
	],
);

export const vaultKeyWrapper = sqliteTable(
	"vault_key_wrapper",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		keyVersion: integer("key_version").notNull(),
		kind: text("kind").notNull(),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		envelopeJson: text("envelope_json", { mode: "json" }).$type<VaultKeyEnvelope>().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.defaultNow()
			.notNull(),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		index("vault_key_wrapper_vaultId_idx").on(table.vaultId),
		index("vault_key_wrapper_userId_idx").on(table.userId),
		uniqueIndex("vault_key_wrapper_vault_kind_user_unique").on(
			table.vaultId,
			table.kind,
			table.userId,
		),
	],
);

export const vaultSyncStatus = sqliteTable(
	"vault_sync_status",
	{
		vaultId: text("vault_id")
			.primaryKey()
			.references(() => vault.id, { onDelete: "cascade" }),
		healthStatus: text("health_status").notNull().default("unknown"),
		healthReasonsJson: text("health_reasons_json").notNull().default("[]"),
		currentCursor: integer("current_cursor").notNull().default(0),
		entryCount: integer("entry_count").notNull().default(0),
		liveBlobCount: integer("live_blob_count").notNull().default(0),
		stagedBlobCount: integer("staged_blob_count").notNull().default(0),
		pendingDeleteBlobCount: integer("pending_delete_blob_count").notNull().default(0),
		storageUsedBytes: integer("storage_used_bytes").notNull().default(0),
		storageLimitBytes: integer("storage_limit_bytes").notNull().default(0),
		activeLocalVaultCount: integer("active_local_vault_count").notNull().default(0),
		websocketCount: integer("websocket_count").notNull().default(0),
		oldestStagedBlobAgeMs: integer("oldest_staged_blob_age_ms"),
		oldestPendingDeleteAgeMs: integer("oldest_pending_delete_age_ms"),
		lastCommitAt: integer("last_commit_at"),
		lastGcAt: integer("last_gc_at"),
		lastFlushedAt: integer("last_flushed_at").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("vault_sync_status_health_idx").on(table.healthStatus, table.updatedAt),
		index("vault_sync_status_storage_idx").on(
			table.storageUsedBytes,
			table.storageLimitBytes,
		),
	],
);

export const vaultRelations = relations(vault, ({ many, one }) => ({
	organization: one(organization, {
		fields: [vault.organizationId],
		references: [organization.id],
	}),
	memberships: many(vaultMembership),
	wrappers: many(vaultKeyWrapper),
	syncStatus: one(vaultSyncStatus, {
		fields: [vault.id],
		references: [vaultSyncStatus.vaultId],
	}),
}));

export const vaultMembershipRelations = relations(vaultMembership, ({ one }) => ({
	vault: one(vault, {
		fields: [vaultMembership.vaultId],
		references: [vault.id],
	}),
	user: one(user, {
		fields: [vaultMembership.userId],
		references: [user.id],
	}),
}));

export const vaultKeyWrapperRelations = relations(vaultKeyWrapper, ({ one }) => ({
	vault: one(vault, {
		fields: [vaultKeyWrapper.vaultId],
		references: [vault.id],
	}),
	user: one(user, {
		fields: [vaultKeyWrapper.userId],
		references: [user.id],
	}),
}));
