import type {
	VaultBootstrapRecord,
	VaultKeyEnvelope,
	VaultKeyWrapperInput,
	VaultKeyWrapperRecord,
	VaultPurgeResult,
	VaultRecord,
} from "../../dto/vault-types";

export interface VaultService {
	listVaults(
		userId: string,
		options?: { includeDeleting?: boolean },
	): Promise<VaultRecord[]>;
	createVault(
		userId: string,
		name: string,
		initialWrapper: VaultKeyWrapperInput,
	): Promise<VaultRecord>;
	getVaultBootstrap(userId: string, vaultId: string): Promise<VaultBootstrapRecord>;
	replacePasswordWrapper(
		userId: string,
		vaultId: string,
		envelope: VaultKeyEnvelope,
	): Promise<VaultKeyWrapperRecord>;
	userCanAccessVault(userId: string, vaultId: string): Promise<boolean>;
	getAccessibleVault(userId: string, vaultId: string): Promise<VaultRecord | null>;
	userCanManageVault(userId: string, vaultId: string): Promise<boolean>;
	deleteVault(userId: string, vaultId: string): Promise<VaultPurgeResult>;
	grantVaultAccess(
		requesterUserId: string,
		vaultId: string,
		input: {
			userId: string;
			role: "admin" | "member";
			memberWrapper: VaultKeyWrapperInput & { kind: "member" };
		},
	): Promise<VaultKeyWrapperRecord>;
}
