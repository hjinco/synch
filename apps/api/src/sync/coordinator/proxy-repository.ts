import type { SubscriptionPlanPolicy } from "../../subscription/policy";

export type CoordinatorStub = {
	fetch(request: Request): Promise<Response>;
};

/**
 * Structural, not `DurableObjectStub`-typed: on Cloudflare this is a real DO
 * namespace binding, but `DurableObjectStub`'s only member this class uses is
 * `fetch()`, so an in-process Node coordinator map satisfies this too.
 */
type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorProxyRepository {
	constructor(private readonly namespace: CoordinatorNamespace) {}

	async fetch(vaultId: string, request: Request): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		return await stub.fetch(request);
	}

	async stageBlob(
		vaultId: string,
		blobId: string,
		sizeBytes: number,
		authorizationHeader?: string | null,
	): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		const headers = new Headers();
		if (authorizationHeader) {
			headers.set("authorization", authorizationHeader);
		}
		headers.set("x-blob-size", String(sizeBytes));

		return await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/stage`,
				{
					method: "PUT",
					headers,
				},
			),
		);
	}

	async abortStagedBlob(
		vaultId: string,
		blobId: string,
		authorizationHeader?: string | null,
	): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		const headers = new Headers();
		if (authorizationHeader) {
			headers.set("authorization", authorizationHeader);
		}

		return await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/stage`,
				{
					method: "DELETE",
					headers,
				},
			),
		);
	}

	async applyVaultPolicy(
		vaultId: string,
		limits: SubscriptionPlanPolicy["limits"],
	): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		return await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/policy`,
				{
					method: "PUT",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify({
						limits: {
							storageLimitBytes: limits.storageLimitBytes,
							maxFileSizeBytes: limits.maxFileSizeBytes,
							versionHistoryRetentionDays:
								limits.versionHistoryRetentionDays,
						},
					}),
				},
			),
		);
	}

	async purgeVault(vaultId: string): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		return await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/purge`,
				{
					method: "POST",
				},
			),
		);
	}
}
