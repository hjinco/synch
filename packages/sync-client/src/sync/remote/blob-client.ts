import { extractErrorMessage, type HttpResponseLike } from "../../http/request";
import { toArrayBuffer } from "@synch/vault-crypto";
import type { SyncAuthorizedRequestClient } from "./request-client";

export class SyncBlobClient {
  constructor(private readonly requestClient: SyncAuthorizedRequestClient) {}

  async uploadBlob(
    vaultId: string,
    blobId: string,
    bytes: Uint8Array,
  ): Promise<void> {
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
  }

  async downloadBlob(vaultId: string, blobId: string): Promise<Uint8Array> {
    const { response } = await this.requestClient.request({
      path: () =>
        `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
    });
    return this.readDownloadResponse(response);
  }

  private readDownloadResponse(response: HttpResponseLike): Uint8Array {
    if (response.status < 200 || response.status >= 300) {
      const message = extractErrorMessage(response.json);
      throw new Error(message || `blob download failed with status ${response.status}`);
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
