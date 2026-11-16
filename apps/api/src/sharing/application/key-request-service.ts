import type { SharingStore } from "./store";
import { isOrganizationManager } from "../domain/policy";
import { forbidden, type SharingAuthorization } from "./authorization";
import type { SharingRefreshService } from "./refresh";
import {
	SharingError,
	type TransferEnvelope,
	type PasswordEnvelope,
	type KeyRequest,
} from "./types";

/** Coordinates encrypted envelopes only; plaintext vault keys stay on clients. */
export class KeyRequestService {
	constructor(
		private readonly store: SharingStore,
		private readonly authorization: SharingAuthorization,
		private readonly refreshes: SharingRefreshService,
	) {}

	async listKeyRequests(userId: string, vaultId: string) {
		const { grant, member } = await this.authorization.requireVault(userId, vaultId, false, true);
		return (await this.store.keyRequests(vaultId)).filter(
			(r) =>
				r.userId === userId ||
				(grant.status === "active" && isOrganizationManager(member.role)),
		);
	}

	async getKeyRequest(userId: string, vaultId: string, id: string) {
		const { grant, member } = await this.authorization.requireVault(userId, vaultId, false, true);
		const request = await this.store.keyRequest(id);
		if (
			!request ||
			request.vaultId !== vaultId ||
			(request.userId !== userId && (grant.status !== "active" || !isOrganizationManager(member.role)))
		)
			forbidden();
		return request;
	}

	async startKeyRequest(
		userId: string,
		vaultId: string,
		id: string,
		publicKey: string,
	) {
		const { vault } = await this.authorization.requireVault(userId, vaultId, false, true);
		await this.authorization.requireSharing(vault.organizationId);
		await this.store.ensureVaultEnrollment(vaultId, userId);
		const { grant } = await this.authorization.requireVault(userId, vaultId, false, true);
		const existing = await this.store.keyRequest(id);
		if (existing) {
			if (
				existing.userId !== userId ||
				existing.vaultId !== vaultId ||
				existing.publicKey !== publicKey
			)
				forbidden();
			return existing;
		}
		const request: KeyRequest = {
			id,
			vaultId,
			userId,
			accessVersion: grant.accessVersion,
			publicKey,
			purpose: grant.status === "pending_key" ? "enrollment" : "recovery",
			status: "pending",
			envelopeJson: null,
			approvedBy: null,
			createdAt: Date.now(),
			expiresAt: Date.now() + 48 * 60 * 60 * 1000,
		};
		await this.store.createKeyRequest(request);
		await this.store.audit(vault.organizationId, userId, "key_requested", id);
		return request;
	}

	async approveKeyRequest(
		userId: string,
		vaultId: string,
		id: string,
		envelope: TransferEnvelope,
	) {
		const { vault } = await this.authorization.requireVault(userId, vaultId, true);
		await this.authorization.requireSharing(vault.organizationId);
		const request = await this.store.keyRequest(id);
		if (!request || request.vaultId !== vaultId || request.userId === userId)
			forbidden();
		await this.authorization.requireVault(request.userId, vaultId, false, true);
		if (
			!(await this.store.approveKeyRequest(
				id,
				userId,
				JSON.stringify(envelope),
			))
		)
			throw new SharingError(
				409,
				"request_changed",
				"Key request changed or expired",
			);
		await this.store.audit(vault.organizationId, userId, "key_approved", id);
	}

	async completeKeyRequest(
		userId: string,
		vaultId: string,
		id: string,
		envelope: PasswordEnvelope,
	) {
		const { vault } = await this.authorization.requireVault(userId, vaultId, false, true);
		await this.authorization.requireSharing(vault.organizationId);
		const request = await this.store.keyRequest(id);
		if (!request || request.userId !== userId || request.vaultId !== vaultId)
			forbidden();
		if (request.status === "completed") {
			if (
				JSON.stringify(await this.store.passwordWrapper(vaultId, userId)) !==
				JSON.stringify(envelope)
			)
				throw new SharingError(
					409,
					"password_changed",
					"Your vault password has changed since this request completed",
				);
			return;
		}
		if (
			envelope.version !== 2 ||
			envelope.binding?.vaultId !== vaultId ||
			envelope.binding?.userId !== userId ||
			envelope.keyVersion !== vault.activeKeyVersion
		)
			throw new SharingError(
				400,
				"invalid_wrapper",
				"Password wrapper does not match this vault and user",
			);
		if (!(await this.store.completeKeyRequest(request, envelope)))
			throw new SharingError(
				409,
				"request_changed",
				"Key request changed or expired",
			);
		await this.refreshes.refresh(vaultId);
		await this.store.audit(vault.organizationId, userId, "key_received", id);
	}
}
