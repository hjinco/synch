import { BlobTransferApplicationError } from "../../application/errors/blob-transfer-errors";
import type {
	BlobStageInput,
	CoordinatorBlobStager,
} from "../../application/ports/outbound/coordinator-blob-stager";

type CoordinatorStub = {
	fetch(request: Request): Promise<Response>;
};

export type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorBlobStagerAdapter implements CoordinatorBlobStager {
	constructor(private readonly namespace: CoordinatorNamespace) {}

	async stageBlob(input: BlobStageInput): Promise<void> {
		const headers = new Headers({ "x-blob-size": String(input.sizeBytes) });
		if (input.token) {
			headers.set("authorization", `Bearer ${input.token}`);
		}
		const response = await this.namespace.getByName(input.vaultId).fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(input.vaultId)}/blobs/${encodeURIComponent(input.blobId)}/stage`,
				{ method: "PUT", headers },
			),
		);
		if (!response.ok) {
			throw await stageRejection(response);
		}
	}

	async abortStagedBlob(
		input: Pick<BlobStageInput, "vaultId" | "blobId" | "token">,
	): Promise<void> {
		const headers = new Headers();
		if (input.token) {
			headers.set("authorization", `Bearer ${input.token}`);
		}
		// The previous proxy deliberately ignored this response. Keep cleanup
		// best-effort so a failed abort never hides the original upload result.
		await this.namespace.getByName(input.vaultId).fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(input.vaultId)}/blobs/${encodeURIComponent(input.blobId)}/stage`,
				{ method: "DELETE", headers },
			),
		);
	}
}

async function stageRejection(response: Response): Promise<BlobTransferApplicationError> {
	const body = (await response.json().catch(() => null)) as {
		error?: unknown;
		reason?: unknown;
		message?: unknown;
	} | null;
	return new BlobTransferApplicationError("coordinator_stage_rejected", {
		reason:
			typeof body?.reason === "string"
				? body.reason
				: typeof body?.error === "string"
					? body.error
					: undefined,
		message: typeof body?.message === "string" ? body.message : undefined,
	});
}
