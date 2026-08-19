import type { VaultInactivityNotice } from "../../domain/types";

export type VaultPurgeMessage =
	| {
			type: "vault_purge";
			vaultId: string;
			reason?: "manual";
	  }
	| {
			type: "vault_purge";
			vaultId: string;
			reason: "inactivity";
			notice: VaultInactivityNotice;
	  };

export type VaultRetentionEmailMessage = {
	type: "vault_retention_email";
	vaultId: string;
	deletedAt: number;
	notice: VaultInactivityNotice;
};
