export type {
	InactiveVaultCandidate,
	VaultInactivityNotice,
	VaultBootstrapRecord,
	VaultKeyDerivationMetadata,
	VaultKeyEnvelope,
	VaultKeyWrapMetadata,
	VaultKeyWrapperInput,
	VaultKeyWrapperKind,
	VaultKeyWrapperRecord,
	VaultRecord,
} from "../../domain/types";

export type VaultPurgeResult = {
	vaultId: string;
	deletionStatus: "queued";
};
