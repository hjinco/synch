import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { SyncTokenService } from "../access/token-service";
import type { CoordinatorProxyRepository } from "../coordinator/proxy-repository";
import { blobObjectKey } from "./object-key";
import type { BlobStorage } from "./storage";
import { BLOB_SIZE_HEADER, limitBodySize, parseBlobSizeHeader } from "./size";
import { Hono } from "hono";

// Both IDs are server/client-generated UUIDs in normal operation, but the
// route param itself accepts any string (Hono decodes %2F into a literal
// "/" in path params) - without this, a blobId like "../other-vault/blob"
// reaches the storage backend's key construction, and on the S3-compatible
// backend a ".." segment survives encodeURIComponent and gets collapsed by
// the WHATWG URL parser, letting one vault's token read/write another
// vault's blobs. Pinning the charset here stops it before it ever reaches
// a storage backend, for every backend, not just the one that happened to
// already guard against it.
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const safeIdSchema = z.string().trim().min(1).regex(SAFE_ID_PATTERN);

export function registerBlobRoutes(
	app: Hono,
	deps: {
		syncTokenService: SyncTokenService;
		blobRepository: BlobStorage;
		coordinatorProxyRepository: CoordinatorProxyRepository;
	},
): void {
	app.put(
		"/v1/vaults/:vaultId/blobs/:blobId",
		zValidator(
			"param",
			z.object({
				vaultId: safeIdSchema,
				blobId: safeIdSchema,
			}),
		),
		async (c) => {
			const request = c.req.raw;
			const { vaultId, blobId } = c.req.valid("param");

			await deps.syncTokenService.requireSyncToken(request, vaultId);
			if (!request.body) {
				return c.json(
					{
						error: "bad_request",
						message: "blob upload requires a request body",
					},
					400,
				);
			}
			const declaredSize = parseBlobSizeHeader(request.headers.get(BLOB_SIZE_HEADER));
			if (declaredSize === null) {
				return c.json(
					{
						error: "bad_request",
						message: `blob upload requires a valid ${BLOB_SIZE_HEADER} header`,
					},
					400,
				);
			}
			const staged = await deps.coordinatorProxyRepository.stageBlob(
				vaultId,
				blobId,
				declaredSize,
				request.headers.get("authorization"),
			);
			if (!staged.ok) {
				return staged;
			}

			const objectKey = blobObjectKey(vaultId, blobId);
			const { readable, sizeMismatch } = limitBodySize(request.body, declaredSize);

			let uploaded: { size: number } | null = null;
			let uploadError: unknown;
			try {
				uploaded = await deps.blobRepository.upload(objectKey, readable);
			} catch (error) {
				uploadError = error;
			}

			// Checked after the upload settles either way: `limitBodySize` stops
			// reading (and aborts the stream) the moment the body exceeds
			// `declaredSize`, well before it could ever reach a backend that
			// buffers uploads in memory - so this is the authoritative signal for
			// "declared size didn't match", not `uploaded.size` (which a backend
			// may never even report if its own consumption of `readable` also
			// rejected once aborted).
			if ((await sizeMismatch) || (uploaded && uploaded.size !== declaredSize)) {
				await deps.blobRepository.delete(objectKey).catch(() => {});
				await deps.coordinatorProxyRepository.abortStagedBlob(
					vaultId,
					blobId,
					request.headers.get("authorization"),
				);
				return c.json(
					{
						error: "size_mismatch",
						message: `declared blob size ${declaredSize} did not match the uploaded body`,
					},
					400,
				);
			}

			if (uploadError) {
				await deps.coordinatorProxyRepository.abortStagedBlob(
					vaultId,
					blobId,
					request.headers.get("authorization"),
				);
				throw uploadError;
			}

			return c.json(
				{
					ok: true,
					blobId,
				},
				201,
			);
		},
	);

	app.get(
		"/v1/vaults/:vaultId/blobs/:blobId",
		zValidator(
			"param",
			z.object({
				vaultId: safeIdSchema,
				blobId: safeIdSchema,
			}),
		),
		async (c) => {
			const request = c.req.raw;
			const { vaultId, blobId } = c.req.valid("param");

			await deps.syncTokenService.requireSyncToken(request, vaultId);
			const body = await deps.blobRepository.download(blobObjectKey(vaultId, blobId));
			if (!body) {
				return c.json(
					{
						error: "not_found",
						message: "blob not found",
					},
					404,
				);
			}

			return new Response(body);
		},
	);
}
