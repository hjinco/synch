import type { BlobDownloadInput } from "../../dto/blob-transfer";

export interface DownloadBlob {
	downloadBlob(input: BlobDownloadInput): Promise<ReadableStream<Uint8Array> | null>;
}
