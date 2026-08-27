import { z, type ZodError } from "zod";

const nonEmptyString = z.string().trim().min(1);

const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().positive();
const requestIdSchema = nonEmptyString;

export const commitMutationPayloadSchema = z
	.object({
		mutationId: nonEmptyString,
		entryId: nonEmptyString,
		op: z.enum(["upsert", "delete"]),
		baseRevision: nonNegativeInteger,
		blobId: nonEmptyString.nullable(),
		encryptedMetadata: nonEmptyString,
	})
	.superRefine((mutation, ctx) => {
		if (mutation.op === "upsert" && mutation.blobId === null) {
			ctx.addIssue({
				code: "custom",
				path: ["blobId"],
				message: "upsert mutations must include a blobId",
			});
		}
		if (mutation.op === "delete" && mutation.blobId !== null) {
			ctx.addIssue({
				code: "custom",
				path: ["blobId"],
				message: "delete mutations must not include a blobId",
			});
		}
	});

export const helloMessageSchema = z.object({
	type: z.literal("hello"),
	requestId: requestIdSchema,
	lastKnownCursor: nonNegativeInteger,
});

export const commitMutationMessageSchema = z.object({
	type: z.literal("commit_mutation"),
	requestId: requestIdSchema,
	mutation: commitMutationPayloadSchema,
});

export const commitMutationsMessageSchema = z.object({
	type: z.literal("commit_mutations"),
	requestId: requestIdSchema,
	mutations: z.array(commitMutationPayloadSchema).min(1).max(100),
});

const entryStatePageCursorSchema = z.object({
	updatedSeq: nonNegativeInteger,
	entryId: nonEmptyString,
});

export const listEntryStatesMessageSchema = z.object({
	type: z.literal("list_entry_states"),
	requestId: requestIdSchema,
	sinceCursor: nonNegativeInteger,
	targetCursor: nonNegativeInteger.nullable(),
	after: entryStatePageCursorSchema.nullable(),
	limit: positiveInteger,
});

const entryVersionPageCursorSchema = z.object({
	capturedAt: nonNegativeInteger,
	versionId: nonEmptyString,
});

const deletedEntryPageCursorSchema = z.object({
	deletedAt: nonNegativeInteger,
	entryId: nonEmptyString,
});

export const listEntryVersionsMessageSchema = z.object({
	type: z.literal("list_entry_versions"),
	requestId: requestIdSchema,
	entryId: nonEmptyString,
	before: entryVersionPageCursorSchema.nullable(),
	limit: positiveInteger,
});

export const listDeletedEntriesMessageSchema = z.object({
	type: z.literal("list_deleted_entries"),
	requestId: requestIdSchema,
	before: deletedEntryPageCursorSchema.nullable(),
	limit: positiveInteger,
});

export const restoreEntryVersionMessageSchema = z.object({
	type: z.literal("restore_entry_version"),
	requestId: requestIdSchema,
	entryId: nonEmptyString,
	versionId: nonEmptyString,
	baseRevision: nonNegativeInteger,
	op: z.enum(["upsert", "delete"]),
	blobId: nonEmptyString.nullable(),
	encryptedMetadata: nonEmptyString,
});

const restoreEntryVersionPayloadSchema = restoreEntryVersionMessageSchema.omit({
	type: true,
	requestId: true,
});

export const restoreEntryVersionsMessageSchema = z.object({
	type: z.literal("restore_entry_versions"),
	requestId: requestIdSchema,
	restores: z.array(restoreEntryVersionPayloadSchema).min(1).max(100),
});

const purgeDeletedEntryPayloadSchema = z.object({
	entryId: nonEmptyString,
	revision: nonNegativeInteger,
});

export const purgeDeletedEntriesMessageSchema = z.object({
	type: z.literal("purge_deleted_entries"),
	requestId: requestIdSchema,
	entries: z.array(purgeDeletedEntryPayloadSchema).min(1).max(100),
});

export const detachLocalVaultMessageSchema = z.object({
	type: z.literal("detach_local_vault"),
	requestId: requestIdSchema,
});

export const heartbeatMessageSchema = z.object({
	type: z.literal("heartbeat"),
	requestId: requestIdSchema,
});

export const watchStorageStatusMessageSchema = z.object({
	type: z.literal("watch_storage_status"),
});

export const unwatchStorageStatusMessageSchema = z.object({
	type: z.literal("unwatch_storage_status"),
});

export const watchPresenceMessageSchema = z.object({
	type: z.literal("watch_presence"),
	entryIds: z.array(nonEmptyString).max(100),
});

export const unwatchPresenceMessageSchema = z.object({
	type: z.literal("unwatch_presence"),
});

const presencePositionSchema = z.object({
	line: nonNegativeInteger,
	ch: nonNegativeInteger,
});

const presenceSelectionSchema = z.object({
	anchor: presencePositionSchema,
	head: presencePositionSchema,
});

export const presenceUpdateMessageSchema = z.object({
	type: z.literal("presence_update"),
	entryId: nonEmptyString,
	selection: presenceSelectionSchema,
});

export const presenceClearMessageSchema = z.object({
	type: z.literal("presence_clear"),
});

export const clientControlMessageSchema = z.discriminatedUnion("type", [
	helloMessageSchema,
	commitMutationsMessageSchema,
	listEntryStatesMessageSchema,
	listEntryVersionsMessageSchema,
	listDeletedEntriesMessageSchema,
	restoreEntryVersionMessageSchema,
	restoreEntryVersionsMessageSchema,
	purgeDeletedEntriesMessageSchema,
	detachLocalVaultMessageSchema,
	heartbeatMessageSchema,
	watchStorageStatusMessageSchema,
	unwatchStorageStatusMessageSchema,
	watchPresenceMessageSchema,
	unwatchPresenceMessageSchema,
	presenceUpdateMessageSchema,
	presenceClearMessageSchema,
]);

export type {
	ClientControlMessage,
	CommitMutationMessage,
	CommitMutationPayload,
	CommitMutationsMessage,
	DetachLocalVaultMessage,
	HeartbeatMessage,
	HelloMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	PresenceClearMessage,
	PresencePosition,
	PresenceSelection,
	RestoreEntryVersionMessage,
	RestoreEntryVersionsMessage,
	UnwatchPresenceMessage,
	UnwatchStorageStatusMessage,
	PresenceUpdateMessage,
	WatchPresenceMessage,
	WatchStorageStatusMessage,
} from "../../../application/dto/protocol-types";

export function parseClientControlMessage(value: unknown) {
	return clientControlMessageSchema.safeParse(value);
}

export function formatClientControlMessageError(error: ZodError): string {
	const issue = error.issues[0];
	if (!issue) {
		return "invalid websocket message";
	}

	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `${path}${issue.message}`;
}
