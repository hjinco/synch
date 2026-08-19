import { describe, expect, it } from "vitest";

import { BlobTransferApplicationError } from "../../../application/errors/blob-transfer-errors";
import { mapBlobTransferApplicationError } from "./error-mapper";

describe("mapBlobTransferApplicationError", () => {
	it("maps paused-vault staging rejections to 403 forbidden", async () => {
		const response = mapBlobTransferApplicationError(
			new BlobTransferApplicationError("coordinator_stage_rejected", {
				reason: "forbidden",
				message: "vault sync is temporarily paused for repair",
			}),
		);

		expect(response?.status).toBe(403);
		await expect(response?.json()).resolves.toMatchObject({ error: "forbidden" });
	});

	it("maps coordinator error codes when the stage body has no reason", async () => {
		const response = mapBlobTransferApplicationError(
			new BlobTransferApplicationError("coordinator_stage_rejected", {
				error: "forbidden",
			}),
		);

		expect(response?.status).toBe(403);
		await expect(response?.json()).resolves.toMatchObject({ error: "forbidden" });
	});

	it("keeps domain staging rejections on their public status and reason", async () => {
		const response = mapBlobTransferApplicationError(
			new BlobTransferApplicationError("coordinator_stage_rejected", {
				reason: "quota_exceeded",
			}),
		);

		expect(response?.status).toBe(413);
		await expect(response?.json()).resolves.toMatchObject({
			error: "quota_exceeded",
			reason: "quota_exceeded",
		});
	});

	it("does not treat unknown staging reasons as client errors", async () => {
		const response = mapBlobTransferApplicationError(
			new BlobTransferApplicationError("coordinator_stage_rejected", {
				reason: "unexpected_coordinator_failure",
			}),
		);

		expect(response?.status).toBe(500);
		await expect(response?.json()).resolves.toMatchObject({ error: "internal_error" });
	});
});
