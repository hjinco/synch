import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { onError } from "../../../../errors";
import { mapSyncCoordinatorApplicationError } from "./error-mapper";
import { BLOB_SIZE_HEADER, parseBlobSizeHeader } from "../../../../platform/http/blob-size";
import { parseBearerToken, SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX } from "../../../../sync-access/application";
import type { SyncPauseState, SyncRepairResult } from "../../../application/dto/sync-repair";
import type { SocketSession, VaultStateLimits } from "../../../application/dto/types";

export interface CoordinatorHttpUseCases {
	repairSyncState(vaultId: string): Promise<SyncRepairResult>;
	readSyncPause(vaultId: string): SyncPauseState | null;
	stageBlob(
		token: string | null,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void>;
	abortStagedBlob(token: string | null, vaultId: string, blobId: string): Promise<void>;
	applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }>;
	purgeVault(vaultId: string): Promise<void>;
	prepareSocketSession(token: string | null, vaultId: string): Promise<SocketSession>;
	completeSocketOpen(): Promise<void>;
}

export type CoordinatorSocketHandshake = {
	openSocket(request: Request, session: SocketSession): Promise<Response>;
};

const policyLimitsSchema = z.object({
	storageLimitBytes: z.number().int().nonnegative(),
	maxFileSizeBytes: z.number().int().nonnegative(),
	versionHistoryRetentionDays: z.number().int().nonnegative(),
});

export function createCoordinatorApp(
	deps: {
		useCases: CoordinatorHttpUseCases;
		socketHandshake: CoordinatorSocketHandshake;
	},
) {
	const app = new Hono();

	app.post(
		"/internal/v1/vaults/:vaultId/sync-repair",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const { vaultId } = c.req.valid("param");
			return c.json(await deps.useCases.repairSyncState(vaultId));
		},
	);

	app.get(
		"/internal/v1/vaults/:vaultId/sync-state",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const { vaultId } = c.req.valid("param");
			return c.json({ syncPause: deps.useCases.readSyncPause(vaultId) });
		},
	);

	app.put(
		"/internal/v1/vaults/:vaultId/blobs/:blobId/stage",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
				blobId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const { vaultId, blobId } = c.req.valid("param");
			const sizeBytes = parseBlobSizeHeader(c.req.raw.headers.get(BLOB_SIZE_HEADER));
			if (sizeBytes === null) {
				return c.json(
					{
						error: "bad_request",
						message: `blob stage requires a valid ${BLOB_SIZE_HEADER} header`,
					},
					400,
				);
			}
			await deps.useCases.stageBlob(readSyncToken(c.req.raw), vaultId, blobId, sizeBytes);
			return new Response(null, { status: 204 });
		},
	);

	app.delete(
		"/internal/v1/vaults/:vaultId/blobs/:blobId/stage",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
				blobId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const { vaultId, blobId } = c.req.valid("param");
			await deps.useCases.abortStagedBlob(readSyncToken(c.req.raw), vaultId, blobId);
			return new Response(null, { status: 204 });
		},
	);

	app.put(
		"/internal/v1/vaults/:vaultId/policy",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		zValidator(
			"json",
			z.object({
				limits: policyLimitsSchema,
			}),
		),
		async (c) => {
			const { vaultId } = c.req.valid("param");
			const body = c.req.valid("json");
			const result = await deps.useCases.applyVaultPolicy(
				vaultId,
				body.limits,
			);
			return c.json(result);
		},
	);

	app.post(
		"/internal/v1/vaults/:vaultId/purge",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const { vaultId } = c.req.valid("param");
			await deps.useCases.purgeVault(vaultId);
			return new Response(null, { status: 204 });
		},
	);

	app.get(
		"/v1/vaults/:vaultId/socket",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const request = c.req.raw;
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return c.json(
					{
						error: "bad_request",
						message: "expected websocket upgrade",
					},
					400,
				);
			}

			const { vaultId } = c.req.valid("param");
			const session = await deps.useCases.prepareSocketSession(
				readSyncToken(request),
				vaultId,
			);
			const response = await deps.socketHandshake.openSocket(request, session);
			await deps.useCases.completeSocketOpen();
			return response;
		},
	);
	app.notFound((c) =>
		c.json(
			{
				error: "not_found",
				message: "unknown sync coordinator route",
			},
			404,
		),
	);

	app.onError((error, c) => mapSyncCoordinatorApplicationError(error) ?? onError(error, c));

	return app;
}

function readSyncToken(request: Request): string | null {
	const bearer = parseBearerToken(request.headers.get("authorization"));
	if (bearer) return bearer;
	const protocols = request.headers.get("sec-websocket-protocol") ?? "";
	for (const protocol of protocols.split(",").map((value) => value.trim())) {
		if (protocol.startsWith(SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX)) {
			const token = protocol.slice(SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX.length);
			if (token) return token;
		}
	}
	return null;
}
