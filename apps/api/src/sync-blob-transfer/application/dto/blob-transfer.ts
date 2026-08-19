export type BlobUploadInput = {
	vaultId: string;
	blobId: string;
	declaredSizeBytes: number;
	token: string | null | undefined;
	body: ReadableStream<Uint8Array>;
};

export type BlobUploadResponse = {
	ok: true;
	blobId: string;
};

export type BlobDownloadInput = {
	vaultId: string;
	blobId: string;
	token: string | null | undefined;
};
