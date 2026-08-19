export type BlobStageInput = {
	vaultId: string;
	blobId: string;
	sizeBytes: number;
	token: string | null | undefined;
};

export interface CoordinatorBlobStager {
	stageBlob(input: BlobStageInput): Promise<void>;
	abortStagedBlob(input: Pick<BlobStageInput, "vaultId" | "blobId" | "token">): Promise<void>;
}
