import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { parseBearerToken } from "../../../../sync-access/application";
import type { DownloadBlob } from "../../../application/ports/inbound/download-blob";
import type { UploadBlob } from "../../../application/ports/inbound/upload-blob";
import { BLOB_SIZE_HEADER, parseBlobSizeHeader } from "./body-size";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const safeIdSchema = z.string().trim().min(1).regex(SAFE_ID_PATTERN);

export function registerBlobTransferRoutes(
	app: Hono,
	deps: { uploadBlob: UploadBlob; downloadBlob: DownloadBlob },
): void {
	app.put(
		"/v1/vaults/:vaultId/blobs/:blobId",
		zValidator(
			"param",
			z.object({ vaultId: safeIdSchema, blobId: safeIdSchema }),
		),
		async (c) => {
			const request = c.req.raw;
			const { vaultId, blobId } = c.req.valid("param");
			if (!request.body) {
				return c.json(
					{ error: "bad_request", message: "blob upload requires a request body" },
					400,
				);
			}
			const declaredSizeBytes = parseBlobSizeHeader(
				request.headers.get(BLOB_SIZE_HEADER),
			);
			if (declaredSizeBytes === null) {
				return c.json(
					{
						error: "bad_request",
						message: `blob upload requires a valid ${BLOB_SIZE_HEADER} header`,
					},
					400,
				);
			}
			return c.json(
				await deps.uploadBlob.uploadBlob({
					vaultId,
					blobId,
					declaredSizeBytes,
					token: parseBearerToken(request.headers.get("authorization")),
					body: request.body,
				}),
				201,
			);
		},
	);

	app.get(
		"/v1/vaults/:vaultId/blobs/:blobId",
		zValidator(
			"param",
			z.object({ vaultId: safeIdSchema, blobId: safeIdSchema }),
		),
		async (c) => {
			const request = c.req.raw;
			const { vaultId, blobId } = c.req.valid("param");
			const body = await deps.downloadBlob.downloadBlob({
				vaultId,
				blobId,
				token: parseBearerToken(request.headers.get("authorization")),
			});
			if (!body) {
				return c.json({ error: "not_found", message: "blob not found" }, 404);
			}
			return new Response(body);
		},
	);
}
