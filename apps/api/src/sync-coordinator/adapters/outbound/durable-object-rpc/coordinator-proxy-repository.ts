import type {
	VerifiedVaultAccess,
	VaultAccessDecision,
} from "../../../application/services/sync-access-service";
import type { SyncTokenClaims } from "../../../../sync-access/application/dto/token";
import { SharingError } from "../../../../sharing/application/types";
import type { SubscriptionPlanPolicy } from "../../../../subscription/application";
import type {
	SyncPauseState,
	SyncRepairResult,
} from "../../../application/ports/outbound";

export type CoordinatorStub = {
	authorizeSyncAccess?(
		input: VerifiedVaultAccess,
	): Promise<VaultAccessDecision>;
	fetch(request: Request): Promise<Response>;
};

/**
 * Structural, not `DurableObjectStub`-typed: on Cloudflare this is a real DO
 * namespace binding; Node supplies the same fetch and typed authorization RPC.
 * Fetch-only transports can use the authenticated internal HTTP endpoint.
 */
export type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorProxyRepository {
	async setSyncPause(vaultId: string, reason: string | null): Promise<Response> {
		return this.fetch(vaultId, new Request(
			`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/${reason === null ? "sync-resume" : "sync-pause"}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) },
		));
	}

	constructor(private readonly namespace: CoordinatorNamespace) {}

	async refreshSharingAccess(vaultId: string): Promise<void> {
		const result = await this.fetch(
			vaultId,
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sharing-refresh`,
				{ method: "POST" },
			),
		);
		if (!result.ok) throw new Error("Unable to apply sharing access changes");
	}
	async authorizeSync(
		vaultId: string,
		token: string,
		claims: SyncTokenClaims,
	): Promise<void> {
		const stub = this.namespace.getByName(vaultId);
		if (stub.authorizeSyncAccess) {
			// Signature, expiry and vault binding have already been checked by VerifySyncTokenService.
			// The coordinator remains the single owner of live authorization and invalidation.
			let result: VaultAccessDecision;
			try {
				result = await stub.authorizeSyncAccess({
					vaultId,
					userId: claims.sub,
					accessVersion: claims.accessVersion ?? 1,
				});
			} catch {
				throw new SharingError(
					503,
					"access_unavailable",
					"Vault access could not be verified",
				);
			}
			if (!result.ok)
				throw new SharingError(result.status, result.code, result.message);
			return;
		}
		// Fetch-only transports retain the fully authenticated internal HTTP route.
		const result = await this.fetch(
			vaultId,
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/authorize`,
				{ method: "POST", headers: { authorization: `Bearer ${token}` } },
			),
		);
		if (!result.ok) {
			const body = (await result.json().catch(() => null)) as {
				error?: string;
				message?: string;
			} | null;
			throw new SharingError(
				result.status >= 500 ? 503 : 403,
				body?.error ?? "access_unavailable",
				body?.message ?? "Vault access could not be verified",
			);
		}
	}
	async fetch(vaultId: string, request: Request): Promise<Response> {
		const stub = this.namespace.getByName(vaultId);
		return await stub.fetch(request);
	}

	async readSyncPause(vaultId: string): Promise<SyncPauseState | null> {
		const stub = this.namespace.getByName(vaultId);
		const response = await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-state`,
			),
		);
		if (!response.ok) {
			throw new Error(
				`failed to read sync state for vault ${vaultId}: ${response.status}`,
			);
		}

		const body = (await response.json()) as {
			syncPause: SyncPauseState | null;
		};
		return body.syncPause;
	}

	async repairSyncState(vaultId: string): Promise<SyncRepairResult> {
		const stub = this.namespace.getByName(vaultId);
		const response = await stub.fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-repair`,
				{ method: "POST" },
			),
		);
		if (!response.ok) {
			throw new Error(
				`failed to repair sync state for vault ${vaultId}: ${response.status}`,
			);
		}

		return (await response.json()) as SyncRepairResult;
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
							versionHistoryRetentionDays: limits.versionHistoryRetentionDays,
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
