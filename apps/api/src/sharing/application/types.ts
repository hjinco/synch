import type { VaultKeyEnvelope } from "../../vault/domain/types";

export type OrganizationRole = "owner" | "admin" | "member";
export type VaultGrant = { vaultId: string };
export type TransferEnvelope = {
	version: 1;
	algorithm: "rsa-oaep-sha256";
	ciphertext: string;
};
export type KeyRequest = {
	id: string;
	vaultId: string;
	userId: string;
	purpose: string;
	accessVersion: number;
	publicKey: string;
	status: string;
	envelopeJson: string | null;
	approvedBy: string | null;
	createdAt: number;
	expiresAt: number;
};
export class SharingError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409 | 429 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
export type SharingActor = { id: string; email: string };
export type PasswordEnvelope = VaultKeyEnvelope;
