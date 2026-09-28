import type {
  BootstrapRemoteVaultInput,
  RemoteVaultRecord,
  SharingManager,
  SharingVault,
} from "@synch/sync-client/remote";
import { OrganizationApiUnavailableError } from "@synch/sync-client/remote";
import { t } from "../../i18n";

export interface VaultAccessContext {
  manager: SharingManager;
  isCurrentAccount(): boolean;
}

export interface ConnectableVault {
  vault: SharingVault;
  organizationName: string;
  sharingEnabled: boolean;
}

export interface ConnectVaultFlowDeps extends VaultAccessContext {
  listLegacyVaults(): Promise<RemoteVaultRecord[]>;
  hasExistingFiles(): Promise<boolean>;
  confirmPersonalVault(): Promise<boolean>;
  bootstrap(input: BootstrapRemoteVaultInput, beforeActivate: () => Promise<void>): Promise<unknown>;
}

/** One connection attempt is bound to the account that opened the picker. */
export class ConnectVaultFlow {
  constructor(private readonly deps: ConnectVaultFlowDeps) {}

  assertCurrentAccount(): void {
    if (!this.deps.isCurrentAccount()) throw new Error(t("sharing.accountChanged"));
  }

  async list(): Promise<ConnectableVault[]> {
    this.assertCurrentAccount();
    let organizations;
    try {
      organizations = await this.deps.manager.client.organizations();
    } catch (error) {
      if (!(error instanceof OrganizationApiUnavailableError)) throw error;
      this.assertCurrentAccount();
      const vaults = await this.deps.listLegacyVaults();
      this.assertCurrentAccount();
      // Preserve the original password-and-merge-confirmation flow. Old servers
      // do not provide sharing provenance, so no enrollment controls are shown.
      return vaults.map(vault => ({
        vault: { id: vault.id, name: vault.name, personal: true, shared: false,
          canManage: false, status: "active", members: [] },
        organizationName: "",
        sharingEnabled: false,
      }));
    }
    this.assertCurrentAccount();
    return organizations.flatMap((organization) =>
      organization.vaults
        .filter((vault) => vault.status === "active" || vault.status === "pending_key")
        .map((vault) => ({
          vault,
          organizationName: organization.name,
          sharingEnabled: organization.sharing.enabled,
        })),
    );
  }

  async blockingReason(item: ConnectableVault): Promise<string | null> {
    if (item.vault.shared && !item.sharingEnabled) return t("sharing.suspended");
    // A vault creator owns its grant, including in an organization they joined.
    // Invited admins and members must both start with an empty local vault.
    if (!item.vault.personal && await this.deps.hasExistingFiles()) {
      return t("vault.invitedNeedsEmpty");
    }
    return null;
  }

  async localRequest(vaultId: string) {
    this.assertCurrentAccount();
    const request = await this.deps.manager.localRequest(vaultId);
    this.assertCurrentAccount();
    return request;
  }

  async verificationCode(vaultId: string): Promise<string> {
    this.assertCurrentAccount();
    const code = await this.deps.manager.recipientVerificationCode(vaultId);
    this.assertCurrentAccount();
    return code;
  }

  async request(vaultId: string, restart = false): Promise<void> {
    const item = await this.requireAvailable(vaultId);
    if (!item.sharingEnabled) throw new Error(t("sharing.suspended"));
    if (restart) await this.deps.manager.restart(vaultId);
    else await this.deps.manager.begin(vaultId);
    this.assertCurrentAccount();
  }

  async connect(vaultId: string, password: string, confirmPassword?: string): Promise<boolean> {
    let item = await this.requireAvailable(vaultId);
    if (item.vault.personal && !await this.deps.confirmPersonalVault()) return false;
    this.assertCurrentAccount();
    if (confirmPassword !== undefined &&
      (item.vault.status === "pending_key" || await this.localRequest(vaultId))) {
      await this.deps.manager.receive(vaultId, password, confirmPassword);
      // Completing enrollment does not change the local connection. Re-read the
      // grant and local files before attaching, including after a slow approval.
      item = await this.requireAvailable(vaultId);
    }
    if (item.vault.status !== "active") throw new Error(t("sharing.waiting"));
    const blocked = await this.blockingReason(item);
    if (blocked) throw new Error(blocked);
    this.assertCurrentAccount();
    await this.deps.bootstrap({ vaultId, password }, async () => {
      const reason = await this.blockingReason(item);
      if (reason) throw new Error(reason);
      this.assertCurrentAccount();
    });
    return true;
  }

  private async requireAvailable(vaultId: string): Promise<ConnectableVault> {
    const item = (await this.list()).find((entry) => entry.vault.id === vaultId);
    if (!item) throw new Error(t("vault.remoteAccessUnavailable"));
    const blocked = await this.blockingReason(item);
    if (blocked) throw new Error(blocked);
    this.assertCurrentAccount();
    return item;
  }
}
