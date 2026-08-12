import { describe, expect, it } from "vitest";

import {
	formatClientControlMessageError,
	parseClientControlMessage,
} from "../protocol";

describe("sync protocol schema", () => {
	it("accepts a valid hello message", () => {
		const parsed = parseClientControlMessage({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: 0,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected hello message to parse");
		}

		expect(parsed.data).toEqual({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: 0,
		});
	});

	it("rejects a negative hello cursor", () => {
		const parsed = parseClientControlMessage({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: -1,
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected hello message to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain("lastKnownCursor");
	});

	it("accepts a local vault detach request", () => {
		const parsed = parseClientControlMessage({
			type: "detach_local_vault",
			requestId: "request-detach",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected detach local vault message to parse");
		}

		expect(parsed.data).toEqual({
			type: "detach_local_vault",
			requestId: "request-detach",
		});
	});

	it("accepts an entry-state delta page request", () => {
		const parsed = parseClientControlMessage({
			type: "list_entry_states",
			requestId: "request-entry-states",
			sinceCursor: 12,
			targetCursor: 20,
			after: {
				updatedSeq: 14,
				entryId: "entry-1",
			},
			limit: 100,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry states message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_entry_states",
			requestId: "request-entry-states",
			sinceCursor: 12,
			targetCursor: 20,
			after: {
				updatedSeq: 14,
				entryId: "entry-1",
			},
			limit: 100,
		});
	});

	it("accepts an entry history request", () => {
		const parsed = parseClientControlMessage({
			type: "list_entry_versions",
			requestId: "request-history",
			entryId: "entry-1",
			before: null,
			limit: 100,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry history message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_entry_versions",
			requestId: "request-history",
			entryId: "entry-1",
			before: null,
			limit: 100,
		});
	});

	it("accepts a deleted entries request", () => {
		const parsed = parseClientControlMessage({
			type: "list_deleted_entries",
			requestId: "request-deleted",
			before: {
				deletedAt: 20,
				entryId: "entry-1",
			},
			limit: 25,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected deleted entries message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_deleted_entries",
			requestId: "request-deleted",
			before: {
				deletedAt: 20,
				entryId: "entry-1",
			},
			limit: 25,
		});
	});

	it("accepts an entry restore request", () => {
		const parsed = parseClientControlMessage({
			type: "restore_entry_version",
			requestId: "request-restore",
			entryId: "entry-1",
			versionId: "version-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			encryptedMetadata: "ciphertext",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry restore message to parse");
		}

		expect(parsed.data).toEqual({
			type: "restore_entry_version",
			requestId: "request-restore",
			entryId: "entry-1",
			versionId: "version-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			encryptedMetadata: "ciphertext",
		});
	});

	it("accepts an entry restore batch request", () => {
		const parsed = parseClientControlMessage({
			type: "restore_entry_versions",
			requestId: "request-restore-batch",
			restores: [
				{
					entryId: "entry-1",
					versionId: "version-1",
					baseRevision: 2,
					op: "upsert",
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry restore batch message to parse");
		}

		expect(parsed.data).toEqual({
			type: "restore_entry_versions",
			requestId: "request-restore-batch",
			restores: [
				{
					entryId: "entry-1",
					versionId: "version-1",
					baseRevision: 2,
					op: "upsert",
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});
	});

	it("accepts a commit batch", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected commit batch to parse");
		}

		expect(parsed.data).toEqual({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});
	});

	it("rejects a blank entry id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "   ",
					op: "upsert",
					baseRevision: 0,
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected commit mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain(
			"mutations.0.entryId",
		);
	});

	it("rejects an upsert mutation without a blob id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 0,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected upsert mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain(
			"mutations.0.blobId",
		);
	});

	it("rejects a delete mutation that still includes a blob id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected delete mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain(
			"mutations.0.blobId",
		);
	});
});
