import type {
	VaultKeyEnvelope,
	VaultKeyWrapperInput,
	VaultKeyWrapperRecord,
	VaultRecord,
} from "../../dto/vault-types";

export interface VaultKeyStore {
	createVaultForUser(
		userId: string,
		organizationId: string,
		name: string,
		initialWrapper: VaultKeyWrapperInput,
	): Promise<VaultRecord>;
	upsertPasswordWrapperForUser(
		userId: string,
		vaultId: string,
		envelope: VaultKeyEnvelope,
	): Promise<VaultKeyWrapperRecord>;
	addVaultMember(
		vaultId: string,
		userId: string,
		role: "admin" | "member",
		wrapper: VaultKeyWrapperInput,
	): Promise<VaultKeyWrapperRecord>;
}
