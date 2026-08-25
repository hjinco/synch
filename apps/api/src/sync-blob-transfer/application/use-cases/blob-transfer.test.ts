import { describe, expect, it, vi } from "vitest";

import { BlobTransferApplicationError } from "../errors/blob-transfer-errors";
import { DownloadBlobUseCase } from "./download-blob";
import { UploadBlobUseCase } from "./upload-blob";

const objectKeyBuilder = {
	blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
	blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
};

function body(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

function storage(overrides: Partial<{
	upload: (...args: never[]) => Promise<{ size: number; sizeMismatch: boolean }>;
	download: (...args: never[]) => Promise<ReadableStream<Uint8Array> | null>;
	delete: (...args: never[]) => Promise<void>;
}> = {}) {
	return {
		upload: vi.fn(async () => ({ size: 3, sizeMismatch: false })),
		download: vi.fn(async () => body("blob")),
		delete: vi.fn(async () => {}),
		deleteMany: vi.fn(async () => ({ failedKeys: [] })),
		deleteByPrefix: vi.fn(async () => {}),
		exists: vi.fn(async () => false),
		...overrides,
	};
}

describe("blob transfer use cases", () => {
	it("stages, uploads, and returns the blob id", async () => {
		const blobStorage = storage();
		const stager = {
			stageBlob: vi.fn(async () => {}),
			abortStagedBlob: vi.fn(async () => {}),
		};
		const verifier = { verifySyncToken: vi.fn(async () => ({}) as never) };
		const useCase = new UploadBlobUseCase(verifier, stager, blobStorage, objectKeyBuilder);

		await expect(
			useCase.uploadBlob({
				vaultId: "vault-1",
				blobId: "blob-1",
				declaredSizeBytes: 3,
				token: "token",
				body: body("abc"),
			}),
		).resolves.toEqual({ ok: true, blobId: "blob-1" });
		expect(verifier.verifySyncToken).toHaveBeenCalledWith("token", "vault-1");
		expect(stager.stageBlob).toHaveBeenCalledWith({
			vaultId: "vault-1",
			blobId: "blob-1",
			sizeBytes: 3,
			token: "token",
		});
		expect(blobStorage.upload).toHaveBeenCalledWith("vault-1/blob-1", expect.anything(), 3);
	});

	it("deletes the object before aborting when the stored size mismatches", async () => {
		const blobStorage = storage({
			upload: vi.fn(async () => ({ size: 2, sizeMismatch: true })),
		});
		const stager = {
			stageBlob: vi.fn(async () => {}),
			abortStagedBlob: vi.fn(async () => {}),
		};
		const verifier = { verifySyncToken: vi.fn(async () => ({}) as never) };
		const useCase = new UploadBlobUseCase(verifier, stager, blobStorage, objectKeyBuilder);

		await expect(
			useCase.uploadBlob({
				vaultId: "vault-1",
				blobId: "blob-1",
				declaredSizeBytes: 3,
				token: "token",
				body: body("abc"),
			}),
		).rejects.toMatchObject({ code: "size_mismatch" });
		expect(blobStorage.delete).toHaveBeenCalledWith("vault-1/blob-1");
		expect(stager.abortStagedBlob).toHaveBeenCalledTimes(1);
	});

	it("aborts a staged blob when storage upload fails", async () => {
		const uploadError = new Error("storage unavailable");
		const blobStorage = storage({ upload: vi.fn(async () => { throw uploadError; }) });
		const stager = {
			stageBlob: vi.fn(async () => {}),
			abortStagedBlob: vi.fn(async () => {}),
		};
		const verifier = { verifySyncToken: vi.fn(async () => ({}) as never) };
		const useCase = new UploadBlobUseCase(verifier, stager, blobStorage, objectKeyBuilder);

		await expect(
			useCase.uploadBlob({
				vaultId: "vault-1",
				blobId: "blob-1",
				declaredSizeBytes: 3,
				token: "token",
				body: body("abc"),
			}),
		).rejects.toBe(uploadError);
		expect(stager.abortStagedBlob).toHaveBeenCalledTimes(1);
	});

	it("verifies before touching storage and rejects unsafe ids", async () => {
		const blobStorage = storage();
		const stager = { stageBlob: vi.fn(), abortStagedBlob: vi.fn() };
		const verifier = { verifySyncToken: vi.fn() };
		const useCase = new UploadBlobUseCase(verifier, stager, blobStorage, objectKeyBuilder);

		await expect(
			useCase.uploadBlob({
				vaultId: "vault-1/other",
				blobId: "blob-1",
				declaredSizeBytes: 3,
				token: "token",
				body: body("abc"),
			}),
		).rejects.toBeInstanceOf(BlobTransferApplicationError);
		expect(verifier.verifySyncToken).not.toHaveBeenCalled();
	});

	it("downloads only after token verification", async () => {
		const blobStorage = storage();
		const verifier = { verifySyncToken: vi.fn(async () => ({}) as never) };
		const useCase = new DownloadBlobUseCase(verifier, blobStorage, objectKeyBuilder);

		await expect(
			useCase.downloadBlob({ vaultId: "vault-1", blobId: "blob-1", token: "token" }),
		).resolves.toBeInstanceOf(ReadableStream);
		expect(blobStorage.download).toHaveBeenCalledWith("vault-1/blob-1");
	});
});
