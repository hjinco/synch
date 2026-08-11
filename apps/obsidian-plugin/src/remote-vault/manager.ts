import {
  createPasswordWrappedRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "@synch/sync-client/remote-vault/crypto";
import { formatVaultPasswordValidationError, t } from "../i18n";
import type { StoredRemoteVaultKeySecret } from "./device-storage";
import { validateVaultPassword } from "@synch/sync-client/remote-vault/password-policy";
import { RemoteVaultClient } from "@synch/sync-client/remote-vault/client";
import type {
  RemoteVaultBootstrapResponse,
  RemoteVaultKeyWrapperRecord,
  RemoteVaultRecord,
  RemoteVaultSession,
  RemoteVaultSessionSummary,
} from "@synch/sync-client/remote-vault/types";

export interface CreateRemoteVaultInput {
  name: string;
  password: string;
  confirmPassword: string;
}

export interface BootstrapRemoteVaultInput {
  vaultId: string;
  password: string;
}

export interface RemoteVaultManagerDeps {
  getApiBaseUrl: () => string;
  getAuthSessionToken: () => string;
  hasAuthenticatedSession: () => boolean;
  getStoredRemoteVaultId: () => string | null;
  getStoredRemoteVaultKeySecret: () => StoredRemoteVaultKeySecret | null;
  saveStoredRemoteVaultKeySecret: (
    vault: StoredRemoteVaultKeySecret | null,
  ) => Promise<void>;
  refreshUi: () => void;
  notify: (message: string) => void;
  remoteVaultClient: RemoteVaultClient;
}

export class RemoteVaultManager {
  private readonly remoteVaultClient: RemoteVaultClient;
  private session: RemoteVaultSession | null = null;

  constructor(private readonly deps: RemoteVaultManagerDeps) {
    this.remoteVaultClient = deps.remoteVaultClient;
  }

  getRemoteVaultStatusLabel(): string {
    if (this.session) {
      return t("vault.loaded", { label: formatVaultLabel(this.session.summary) });
    }

    const storedVaultId = this.deps.getStoredRemoteVaultId();
    if (storedVaultId && this.deps.getStoredRemoteVaultKeySecret()) {
      return t("vault.notActive");
    }

    return t("vault.notConfigured");
  }

  getActiveSession(): RemoteVaultSession | null {
    return this.session;
  }

  getRemoteVaultId(): string | null {
    return this.session?.summary.vaultId ?? null;
  }

  hasConnectedRemoteVault(): boolean {
    return (
      this.session !== null ||
      (this.deps.getStoredRemoteVaultId() !== null &&
        this.deps.getStoredRemoteVaultKeySecret() !== null)
    );
  }

  clearSession(): void {
    this.session = null;
    this.deps.refreshUi();
  }

  async disconnectRemoteVault(options: { notify?: boolean } = {}): Promise<void> {
    const vault = this.session?.summary ?? this.deps.getStoredRemoteVaultId();
    this.session = null;
    await this.deps.saveStoredRemoteVaultKeySecret(null);
    this.deps.refreshUi();

    if (vault && options.notify !== false) {
      this.notify(t("vault.disconnected", { label: formatStoredVaultLabel(vault) }));
    }
  }

  async restoreStoredSessionIfNeeded(): Promise<void> {
    if (this.session || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    const remoteVaultId = this.deps.getStoredRemoteVaultId();
    const storedVaultKey = this.deps.getStoredRemoteVaultKeySecret();
    if (!remoteVaultId || !storedVaultKey) {
      return;
    }

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      remoteVaultId,
    );

    this.session = {
      summary: {
        vaultId: bootstrap.vault.id,
        vaultName: bootstrap.vault.name,
        activeKeyVersion: bootstrap.vault.activeKeyVersion,
        bootstrappedAt: new Date().toISOString(),
      },
      remoteVaultKey: storedVaultKey.remoteVaultKey,
    };
    this.deps.refreshUi();
  }

  async listRemoteVaults(): Promise<RemoteVaultRecord[]> {
    this.ensureAuthenticated();

    const listed = await this.remoteVaultClient.listRemoteVaults(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
    );

    return listed.vaults;
  }

  async createRemoteVault(input: CreateRemoteVaultInput): Promise<RemoteVaultSessionSummary> {
    this.ensureAuthenticated();
    validateCreateInput(input);

    const wrapper = await createPasswordWrappedRemoteVaultKey(input.password);
    const { vault } = await this.remoteVaultClient.createRemoteVault(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      {
        name: input.name.trim(),
        initialWrapper: {
          kind: "password",
          envelope: wrapper.envelope,
        },
      },
    );

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      vault.id,
    );
    await this.loadBootstrapRemoteVaultSession(bootstrap, input.password);

    const summary = this.requireSession().summary;
    this.notify(t("vault.createdConnected", { label: summary.vaultName }));
    return summary;
  }

  async bootstrapRemoteVault(input: BootstrapRemoteVaultInput): Promise<RemoteVaultSessionSummary> {
    this.ensureAuthenticated();

    const vaultId = input.vaultId.trim();
    if (!vaultId) {
      throw new Error("Vault selection is required.");
    }

    const password = input.password;
    if (!password) {
      throw new Error("Password is required.");
    }

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      vaultId,
    );
    await this.loadBootstrapRemoteVaultSession(bootstrap, password);

    const summary = this.requireSession().summary;
    this.notify(t("vault.connected", { label: summary.vaultName }));
    return summary;
  }

  private async loadBootstrapRemoteVaultSession(
    bootstrap: RemoteVaultBootstrapResponse,
    password: string,
  ): Promise<void> {
    const wrapper = findPasswordWrapper(bootstrap.wrappers);
    const remoteVaultKey = await unwrapRemoteVaultKey(password, wrapper.envelope);
    const summary: RemoteVaultSessionSummary = {
      vaultId: bootstrap.vault.id,
      vaultName: bootstrap.vault.name,
      activeKeyVersion: bootstrap.vault.activeKeyVersion,
      bootstrappedAt: new Date().toISOString(),
    };

    this.session = {
      summary,
      remoteVaultKey,
    };
    await this.deps.saveStoredRemoteVaultKeySecret({
      remoteVaultKey,
    });
    this.deps.refreshUi();
  }

  private ensureAuthenticated(): void {
    if (!this.deps.hasAuthenticatedSession()) {
      throw new Error("Sign in before managing a vault.");
    }
  }

  private notify(message: string): void {
    this.deps.notify(message);
  }

  private requireSession(): RemoteVaultSession {
    if (!this.session) {
      throw new Error("Vault session is not loaded.");
    }

    return this.session;
  }
}

async function unwrapRemoteVaultKey(
  password: string,
  envelope: RemoteVaultBootstrapResponse["wrappers"][number]["envelope"],
): Promise<Uint8Array> {
  try {
    return await unwrapRemoteVaultKeyWithPassword(password, envelope);
  } catch (error) {
    if (isCryptoOperationError(error)) {
      throw new Error("Unable to unlock vault. Check the password and try again.");
    }

    throw error;
  }
}

function isCryptoOperationError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "OperationError";
}

function validateCreateInput(input: CreateRemoteVaultInput): void {
  if (!input.name.trim()) {
    throw new Error(t("vault.nameRequired"));
  }

  const passwordValidation = validateVaultPassword(input.password);
  if (!passwordValidation.ok) {
    throw new Error(formatVaultPasswordValidationError(passwordValidation));
  }

  if (input.password !== input.confirmPassword) {
    throw new Error(t("vault.passwordMismatch"));
  }
}

function findPasswordWrapper(
  wrappers: RemoteVaultKeyWrapperRecord[],
): RemoteVaultKeyWrapperRecord {
  const wrapper =
    wrappers.find(
      (candidate) =>
        candidate.kind === "password" &&
        candidate.userId !== null &&
        candidate.revokedAt === null,
    ) ??
    wrappers.find(
      (candidate) => candidate.kind === "password" && candidate.revokedAt === null,
    );

  if (!wrapper) {
    throw new Error("No active password wrapper found for this vault.");
  }

  return wrapper;
}

function formatVaultLabel(vault: Pick<RemoteVaultSessionSummary, "vaultId" | "vaultName">): string {
  return vault.vaultName;
}

function formatStoredVaultLabel(
  vault: string | RemoteVaultSessionSummary,
): string {
  if (typeof vault === "string") {
    return vault;
  }

  if (vault.vaultName) {
    return vault.vaultName;
  }

  return vault.vaultId;
}
