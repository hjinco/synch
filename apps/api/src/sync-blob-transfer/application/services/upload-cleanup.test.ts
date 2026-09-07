import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDiskBlobObjectStorage } from "../../adapters/outbound/local-disk-object-storage";
import { BlobTransferService } from "./blob-transfer-service";
import { BlobService } from "../../../sync-coordinator/application/services/blob-service";
import { BlobGcService } from "../../../sync-coordinator/application/services/blob-gc-service";
import {
	createSqliteCoordinator,
	closeAllTestSqliteCoordinators,
} from "../../../sync-coordinator/adapters/outbound/sqlite/test-helpers";

let directory: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	closeAllTestSqliteCoordinators();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

it("retains a completed object after a failed retry until GC removes its object and accounting together", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1_000);
	const { unitOfWork, blobStore, healthStore } = await createSqliteCoordinator();
	directory = mkdtempSync(path.join(tmpdir(), "synch-upload-cleanup-"));
	const storage = new LocalDiskBlobObjectStorage(directory);
	const keys = {
		blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
		blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
	};
	const health = { scheduleSummaryFlush: vi.fn(async () => {}), notifyStorageStatusChanged: vi.fn() };
	const scheduler = { defer: vi.fn(async () => {}) };
	const gc = new BlobGcService(unitOfWork.stores.state, unitOfWork, storage, keys, scheduler, health);
	const verifier = { verifySyncToken: vi.fn(async () => ({
		sub: "user", displayName: "User", vaultId: "vault-1", localVaultId: "device", scope: "vault:sync" as const, iat: 0, exp: 10_000,
	})) };
	const blobs = new BlobService(verifier, unitOfWork, gc, { closeAllSockets: vi.fn() }, storage, keys, 100, health);
	const transfer = new BlobTransferService(verifier, {
		stageBlob: (input) => blobs.stageBlob(input.token, input.vaultId, input.blobId, input.sizeBytes),
		abortStagedBlob: (input) => blobs.abortStagedBlob(input.vaultId, input.blobId),
	}, storage, keys);
	const upload = (text: string) => transfer.uploadBlob({
		vaultId: "vault-1", blobId: "blob", token: "token", declaredSizeBytes: 4,
		body: new Response(text).body!,
	});

	await upload("good");
	vi.mocked(Date.now).mockReturnValue(1_010);
	await expect(upload("bad")).rejects.toMatchObject({ code: "size_mismatch" });
	expect(await new Response(await storage.download("vault-1/blob")).text()).toBe("good");
	expect(blobStore.readBlob("blob")).toMatchObject({ state: "staged", delete_after: 1_110 });
	expect(healthStore.readStorageStatus().storageUsedBytes).toBe(4);
	expect(scheduler.defer).toHaveBeenLastCalledWith("blob_gc", 1_110, 1_010);

	await gc.runGc("vault-1", { now: 1_109 });
	expect(await storage.exists("vault-1/blob")).toBe(true);
	await gc.runGc("vault-1", { now: 1_110 });
	expect(await storage.exists("vault-1/blob")).toBe(false);
	expect(blobStore.readBlob("blob")).toBeNull();
	expect(healthStore.readStorageStatus().storageUsedBytes).toBe(0);
});
