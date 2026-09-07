import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { issueSyncToken, signUpAndCreateVault } from "../../helpers/api";
import { commitMutation, listEntryStates, uploadBlob } from "./helpers";

describe("sync durable object entry-state integration", () => {
	it("reports the uploaded encrypted body size in entry-state responses", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "size-device");
		const body = "encrypted-body";
		await uploadBlob(primary.vaultId, token.token, "sized-blob", body);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = { userId: primary.userId, localVaultId: "size-device", vaultId: primary.vaultId };
		await commitMutation(stub, session, {
			mutationId: "sized-mutation", entryId: "sized-entry", op: "upsert", baseRevision: 0,
			blobId: "sized-blob", encryptedMetadata: "encrypted-metadata",
		});
		const page = await listEntryStates(stub, session, {
			sinceCursor: 0, targetCursor: null, after: null, limit: 10,
		});
		expect(page.entries).toEqual([expect.objectContaining({
			blobId: "sized-blob", blobSize: new TextEncoder().encode(body).byteLength,
		})]);
	});

	it("returns latest entry-state deltas with retained delete tombstones", async () => {
		const primary = await signUpAndCreateVault();
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-entry-states",
			vaultId: primary.vaultId,
		};

		await commitMutation(stub, session, {
			mutationId: "entry-state-a-1",
			entryId: "entry-a",
			op: "upsert",
			baseRevision: 0,
			blobId: null,
			encryptedMetadata: "meta-a-1",
		});
		await commitMutation(stub, session, {
			mutationId: "entry-state-a-2",
			entryId: "entry-a",
			op: "upsert",
			baseRevision: 1,
			blobId: null,
			encryptedMetadata: "meta-a-2",
		});
		await commitMutation(stub, session, {
			mutationId: "entry-state-b-1",
			entryId: "entry-b",
			op: "upsert",
			baseRevision: 0,
			blobId: null,
			encryptedMetadata: "meta-b-1",
		});
		await commitMutation(stub, session, {
			mutationId: "entry-state-b-2",
			entryId: "entry-b",
			op: "delete",
			baseRevision: 1,
			blobId: null,
			encryptedMetadata: "meta-b-delete",
		});

		const page = await listEntryStates(stub, session, {
			sinceCursor: 0,
			targetCursor: null,
			after: null,
			limit: 10,
		});

		expect(page.targetCursor).toBe(4);
		expect(page.hasMore).toBe(false);
		expect(page.entries).toEqual([
			expect.objectContaining({
				entryId: "entry-a",
				revision: 2,
				encryptedMetadata: "meta-a-2",
				deleted: false,
				updatedSeq: 2,
			}),
			expect.objectContaining({
				entryId: "entry-b",
				revision: 2,
				encryptedMetadata: "meta-b-delete",
				blobSize: null,
				deleted: true,
				updatedSeq: 4,
			}),
		]);
	});
});
