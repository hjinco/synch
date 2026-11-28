import { extractErrorMessage, type HttpResponseLike } from "../../http/request";
import { toArrayBuffer } from "@synch/vault-crypto";
import type { FileTransferLog } from "../diagnostics/file-transfer";
import { TransferScheduler, type TransferDirection, type TransferResult } from "./transfer-scheduler";
import type { SyncAuthorizedRequestClient } from "./request-client";

export class SyncBlobClient {
  constructor(
    private readonly requestClient: SyncAuthorizedRequestClient,
    private readonly transfers = new TransferScheduler(),
  ) {}

  async uploadBlob(
    vaultId: string,
    blobId: string,
    bytes: Uint8Array,
    transfer?: FileTransferLog,
  ): Promise<void> {
    return await this.schedule("upload", transfer, async () => {
      const { response } = await this.requestClient.request({
        path: () =>
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
        method: "PUT",
        body: toArrayBuffer(bytes),
        headers: {
          "x-blob-size": String(bytes.byteLength),
        },
      });
      this.throwUnlessUploadSucceeded(response);
      return { value: undefined, bytes: response.status === 409 ? 0 : bytes.byteLength };
    });
  }

  async downloadBlob(vaultId: string, blobId: string, transfer?: FileTransferLog): Promise<Uint8Array> {
    return await this.schedule("download", transfer, async () => {
      const { response } = await this.requestClient.request({
        path: () =>
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      });
      const bytes = this.readDownloadResponse(response);
      return { value: bytes, bytes: bytes.byteLength };
    });
  }

  private schedule<T>(
    direction: TransferDirection,
    transfer: FileTransferLog | undefined,
    work: () => Promise<TransferResult<T>>,
  ): Promise<T> {
    return this.transfers.run(direction, () => transfer ? transfer.run(direction, work) : work());
  }

  private readDownloadResponse(response: HttpResponseLike): Uint8Array {
    if (response.status < 200 || response.status >= 300) {
      const message = extractErrorMessage(response.json);
      throw new SyncBlobDownloadError(
        response.status,
        message || `blob download failed with status ${response.status}`,
        extractErrorCode(response.json),
      );
    }

    if (response.arrayBuffer instanceof ArrayBuffer) {
      return new Uint8Array(response.arrayBuffer);
    }

    throw new Error("blob download response did not include an ArrayBuffer body");
  }

  private throwUnlessUploadSucceeded(response: { status: number; json?: unknown }): void {
    if (response.status >= 200 && response.status < 300) {
      return;
    }

    if (response.status === 409) {
      return;
    }

    const message = extractErrorMessage(response.json);
    throw new SyncBlobUploadError(
      response.status,
      extractErrorCode(response.json),
      message || `blob upload failed with status ${response.status}`,
    );
  }
}

export class SyncBlobUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncBlobUploadError";
  }
}

function extractErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  return typeof record.error === "string" ? record.error.trim() : "";
}

export class SyncBlobDownloadError extends Error {
  constructor(readonly status: number, message: string, readonly code = "") {
    super(message);
    this.name = "SyncBlobDownloadError";
  }
}
