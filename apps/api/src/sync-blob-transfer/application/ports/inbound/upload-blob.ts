import type {
	BlobUploadInput,
	BlobUploadResponse,
} from "../../dto/blob-transfer";

export interface UploadBlob {
	uploadBlob(input: BlobUploadInput): Promise<BlobUploadResponse>;
}
