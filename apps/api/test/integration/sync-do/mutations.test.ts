import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { initializeCoordinatorState, signUpAndCreateVault } from "../../helpers/api";
import type { SyncDoSession, SyncMutation } from "./helpers";

describe("sync durable object mutation integration", () => {
	it("rejects duplicate mutation ids in the same batch", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);

		const committed = await runInDurableObject(stub, async (instance, state) => {
			const coordinator = instance as unknown as {
				commitMutations: (
					session: SyncDoSession,
					message: {
						type: "commit_mutations";
						requestId: string;
						mutations: SyncMutation[];
					},
				) => Promise<{
					message: {
						type: string;
						requestId: string;
						cursor: number;
						results: Array<{
							status: "accepted" | "rejected";
							mutationId: string;
							entryId: string;
							cursor?: number;
							revision?: number;
							code?: string;
							message?: string;
						}>;
					};
					broadcastCursor: number | null;
				}>;
			};

			const session = {
				userId: primary.userId,
				localVaultId: "local-vault-a",
				vaultId: primary.vaultId,
			};

			const result = await coordinator.commitMutations(session, {
				type: "commit_mutations",
				requestId: "request-duplicate-batch",
				mutations: [
					{
						mutationId: "mutation-duplicate",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-a",
					},
					{
						mutationId: "mutation-duplicate",
						entryId: "entry-2",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-b",
					},
				],
			});
			const entries = state.storage.sql
				.exec<{ entry_id: string }>("SELECT entry_id FROM entries ORDER BY entry_id")
				.toArray()
				.map((entry) => entry.entry_id);

			return { result, entries };
		});

		expect(committed.result.message.results).toMatchObject([
			{
				status: "accepted",
				mutationId: "mutation-duplicate",
				entryId: "entry-1",
				revision: 1,
			},
			{
				status: "rejected",
				mutationId: "mutation-duplicate",
				entryId: "entry-2",
				code: "duplicate_mutation_id",
				message: expect.any(String),
			},
		]);
		expect(committed.result.broadcastCursor).toBe(
			committed.result.message.results[0]?.cursor,
		);
		expect(committed.entries).toEqual(["entry-1"]);
	});

	it("assigns consecutive cursors to accepted mutations in one batch", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);

		const committed = await runInDurableObject(stub, async (instance, state) => {
			const coordinator = instance as unknown as {
				commitMutations: (
					session: SyncDoSession,
					message: {
						type: "commit_mutations";
						requestId: string;
						mutations: SyncMutation[];
					},
				) => Promise<{
					message: {
						type: string;
						requestId: string;
						cursor: number;
						results: Array<{
							status: "accepted" | "rejected";
							mutationId: string;
							entryId: string;
							cursor?: number;
							revision?: number;
							code?: string;
						}>;
					};
					broadcastCursor: number | null;
				}>;
			};

			const session = {
				userId: primary.userId,
				localVaultId: "local-vault-a",
				vaultId: primary.vaultId,
			};

			const result = await coordinator.commitMutations(session, {
				type: "commit_mutations",
				requestId: "request-cursor-batch",
				mutations: [
					{
						mutationId: "mutation-a",
						entryId: "entry-a",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-a",
					},
					{
						mutationId: "mutation-b",
						entryId: "entry-b",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-b",
					},
					{
						mutationId: "mutation-c",
						entryId: "entry-c",
						op: "upsert",
						baseRevision: 1,
						blobId: null,
						encryptedMetadata: "ciphertext-c",
					},
				],
			});
			const stateRow = state.storage.sql
				.exec<{ current_cursor: number }>(
					"SELECT current_cursor FROM coordinator_state WHERE id = 1",
				)
				.toArray()[0];
			const entries = state.storage.sql
				.exec<{ entry_id: string; updated_seq: number }>(
					"SELECT entry_id, updated_seq FROM entries ORDER BY entry_id",
				)
				.toArray();

			return {
				result,
				currentCursor: Number(stateRow?.current_cursor ?? 0),
				entries: entries.map((entry) => ({
					entryId: entry.entry_id,
					updatedSeq: Number(entry.updated_seq),
				})),
			};
		});

		expect(committed.result.message.results).toMatchObject([
			{
				status: "accepted",
				mutationId: "mutation-a",
				entryId: "entry-a",
				cursor: 1,
				revision: 1,
			},
			{
				status: "accepted",
				mutationId: "mutation-b",
				entryId: "entry-b",
				cursor: 2,
				revision: 1,
			},
			{
				status: "rejected",
				mutationId: "mutation-c",
				entryId: "entry-c",
				code: "stale_revision",
			},
		]);
		expect(committed.result.message.cursor).toBe(2);
		expect(committed.result.broadcastCursor).toBe(2);
		expect(committed.currentCursor).toBe(2);
		expect(committed.entries).toEqual([
			{ entryId: "entry-a", updatedSeq: 1 },
			{ entryId: "entry-b", updatedSeq: 2 },
		]);
	});

	it("deduplicates a latest idempotent retry from the entry row", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);

		const retried = await runInDurableObject(stub, async (instance, state) => {
			const coordinator = instance as unknown as {
				commitMutation: (
					session: SyncDoSession,
					message: {
						type: "commit_mutation";
						requestId: string;
						mutation: SyncMutation;
					},
				) => Promise<{
					message: {
						type: string;
						requestId: string;
						cursor: number;
						revision: number;
					};
					broadcastCursor: number | null;
				}>;
			};

			const session = {
				userId: primary.userId,
				localVaultId: "local-vault-a",
				vaultId: primary.vaultId,
			};

			const first = await coordinator.commitMutation(session, {
				type: "commit_mutation",
				requestId: "request-first",
				mutation: {
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 0,
					blobId: null,
					encryptedMetadata: "ciphertext-a",
				},
			});
			const second = await coordinator.commitMutation(session, {
				type: "commit_mutation",
				requestId: "request-second",
				mutation: {
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 0,
					blobId: null,
					encryptedMetadata: "ciphertext-b",
				},
			});
			const entry = state.storage.sql
				.exec<{ updated_seq: number; last_mutation_id: string | null }>(
					"SELECT updated_seq, last_mutation_id FROM entries WHERE entry_id = ?",
					"entry-1",
				)
				.toArray()[0];

			return {
				first,
				second,
				updatedSeq: Number(entry?.updated_seq ?? 0),
				lastMutationId: entry?.last_mutation_id ?? null,
			};
		});

		expect(retried.first.message.type).toBe("commit_accepted");
		expect(retried.second.message).toEqual({
			...retried.first.message,
			requestId: "request-second",
		});
		expect(retried.second.broadcastCursor).toBeNull();
		expect(retried.updatedSeq).toBe(retried.first.message.cursor);
		expect(retried.lastMutationId).toBe("mutation-1");
	});

	it("rejects an old retry after a newer mutation is committed", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);

		const retried = await runInDurableObject(stub, async (instance, state) => {
			const coordinator = instance as unknown as {
				commitMutation: (
					session: SyncDoSession,
					message: {
						type: "commit_mutation";
						requestId: string;
						mutation: SyncMutation;
					},
				) => Promise<{
					message: {
						type: string;
						requestId: string;
						cursor?: number;
						revision?: number;
						code?: string;
						message?: string;
						expectedBaseRevision?: number;
						receivedBaseRevision?: number;
					};
					broadcastCursor: number | null;
				}>;
			};

			const session = {
				userId: primary.userId,
				localVaultId: "local-vault-a",
				vaultId: primary.vaultId,
			};
			const mutationA: SyncMutation = {
				mutationId: "mutation-a",
				entryId: "entry-1",
				op: "upsert",
				baseRevision: 0,
				blobId: null,
				encryptedMetadata: "ciphertext-a",
			};

			const first = await coordinator.commitMutation(session, {
				type: "commit_mutation",
				requestId: "request-a",
				mutation: mutationA,
			});
			const second = await coordinator.commitMutation(session, {
				type: "commit_mutation",
				requestId: "request-b",
				mutation: {
					mutationId: "mutation-b",
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "ciphertext-b",
				},
			});
			const oldRetry = await coordinator.commitMutation(session, {
				type: "commit_mutation",
				requestId: "request-a-retry",
				mutation: mutationA,
			});
			const entry = state.storage.sql
				.exec<{
					revision: number;
					encrypted_metadata: string;
					last_mutation_id: string | null;
				}>(
					"SELECT revision, encrypted_metadata, last_mutation_id FROM entries WHERE entry_id = ?",
					"entry-1",
				)
				.toArray()[0];

			return { first, second, oldRetry, entry };
		});

		expect(retried.first.message).toMatchObject({
			type: "commit_accepted",
			revision: 1,
		});
		expect(retried.second.message).toMatchObject({
			type: "commit_accepted",
			revision: 2,
		});
		expect(retried.oldRetry).toEqual({
			message: {
				type: "commit_rejected",
				requestId: "request-a-retry",
				code: "stale_revision",
				message: expect.any(String),
				expectedBaseRevision: 2,
				receivedBaseRevision: 0,
			},
			broadcastCursor: null,
		});
		expect(retried.entry).toMatchObject({
			revision: 2,
			encrypted_metadata: "ciphertext-b",
			last_mutation_id: "mutation-b",
		});
	});
});
