export type VaultKeyWrapperKind = "password" | "member" | "recovery";

export type VaultKeyDerivationMetadata = {
	name: string;
	memoryKiB: number;
	iterations: number;
	parallelism: number;
	salt: string;
};

export type VaultKeyWrapMetadata = {
	algorithm: string;
	nonce: string;
	ciphertext: string;
};

export type VaultKeyEnvelope = {
	version: number;
	keyVersion: number;
	kdf: VaultKeyDerivationMetadata;
	wrap: VaultKeyWrapMetadata;
};

export type VaultKeyWrapperInput = {
	kind: VaultKeyWrapperKind;
	envelope: VaultKeyEnvelope;
};

export type VaultRecord = {
	id: string;
	organizationId: string;
	name: string;
	activeKeyVersion: number;
	syncFormatVersion: number;
	createdAt: Date;
	deletedAt: Date | null;
	purgeStatus: "queued" | "running" | "failed" | null;
	purgeError: string | null;
};

export type VaultKeyWrapperRecord = {
	id: string;
	vaultId: string;
	keyVersion: number;
	kind: VaultKeyWrapperKind;
	userId: string | null;
	envelope: VaultKeyEnvelope;
	createdAt: Date;
	revokedAt: Date | null;
};

export type VaultBootstrapRecord = {
	vault: VaultRecord;
	wrappers: VaultKeyWrapperRecord[];
};

/** A vault whose content has not changed since the inactivity cutoff. */
export type InactiveVaultCandidate = {
	vaultId: string;
	organizationId: string;
	vaultName: string;
	ownerEmail: string;
	lastCommitAt: number | null;
};
