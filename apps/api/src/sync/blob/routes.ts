import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { SyncTokenService } from "../access/token-service";
import type { CoordinatorProxyRepository } from "../coordinator/proxy-repository";
import { blobObjectKey } from "./object-key";
import type { BlobStorage } from "./storage";
import { BLOB_SIZE_HEADER, parseBlobSizeHeader } from "./size";
import { Hono } from "hono";

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
				vaultId: z.string().trim().min(1),
				blobId: z.string().trim().min(1),
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
			try {
				const uploaded = await deps.blobRepository.upload(objectKey, request.body);
				if (uploaded.size !== declaredSize) {
					await deps.blobRepository.delete(objectKey);
					await deps.coordinatorProxyRepository.abortStagedBlob(
						vaultId,
						blobId,
						request.headers.get("authorization"),
					);
					return c.json(
						{
							error: "size_mismatch",
							message: `declared blob size ${declaredSize} did not match uploaded size ${uploaded.size}`,
						},
						400,
					);
				}
			} catch (error) {
				await deps.coordinatorProxyRepository.abortStagedBlob(
					vaultId,
					blobId,
					request.headers.get("authorization"),
				);
				throw error;
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
				vaultId: z.string().trim().min(1),
				blobId: z.string().trim().min(1),
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
