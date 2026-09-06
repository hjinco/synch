import { describe, expect, it, vi } from "vitest";

import { SyncAccessApplicationError } from "../../../../sync-access/application";
import { BLOB_SIZE_HEADER } from "../../../../platform/http/blob-size";
import { createCoordinatorApp, type CoordinatorHttpServices } from "./routes";

function unused(): never {
	throw new Error("unexpected coordinator use case call");
}

function appWithStageError(error: SyncAccessApplicationError) {
	const services = {
		repairSyncState: unused,
		readSyncPause: unused,
		stageBlob: vi.fn(async () => {
			throw error;
		}),
		abortStagedBlob: unused,
		applyVaultPolicy: unused,
		purgeVault: unused,
		prepareSocketSession: unused,
		completeSocketOpen: unused,
	} satisfies CoordinatorHttpServices;
	return {
		app: createCoordinatorApp({
			services,
			socketHandshake: { openSocket: unused },
		}),
		services,
	};
}

describe("coordinator HTTP routes", () => {
	it("maps a missing sync token on blob stage to 401 unauthorized", async () => {
		const { app, services } = appWithStageError(
			new SyncAccessApplicationError("missing_token"),
		);
		const response = await app.request(
			"/internal/v1/vaults/vault-1/blobs/blob-1/stage",
			{
				method: "PUT",
				headers: { [BLOB_SIZE_HEADER]: "42" },
			},
		);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
		expect(services.stageBlob).toHaveBeenCalledWith(null, "vault-1", "blob-1", 42);
	});

	it("maps a vault mismatch on blob stage to 403 forbidden", async () => {
		const { app } = appWithStageError(new SyncAccessApplicationError("vault_mismatch"));
		const response = await app.request(
			"/internal/v1/vaults/vault-1/blobs/blob-1/stage",
			{
				method: "PUT",
				headers: { [BLOB_SIZE_HEADER]: "42" },
			},
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
	});
});
