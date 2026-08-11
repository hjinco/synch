import {
  createPasswordWrappedRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "./crypto";
import {
  validateVaultPassword,
  type VaultPasswordValidation,
} from "./password-policy";
import { RemoteVaultClient } from "./client";
import type {
  RemoteVaultBootstrapResponse,
  RemoteVaultKeyWrapperRecord,
  RemoteVaultRecord,
  RemoteVaultSession,
  RemoteVaultSessionSummary,
  StoredRemoteVaultKeySecret,
} from "./types";

export interface CreateRemoteVaultInput {
  name: string;
  password: string;
  confirmPassword: string;
}

export interface BootstrapRemoteVaultInput {
  vaultId: string;
  password: string;
}

// Vault state for UI display. Label formatting lives in the host app layer.
export type RemoteVaultStatus =
  | { state: "loaded"; label: string }
  | { state: "stored_inactive" }
  | { state: "not_configured" };

// Vault events that require user notification. Message formatting lives in the
// host app layer.
export type RemoteVaultNoticeEvent =
  | { type: "disconnected"; label: string }
  | { type: "created_connected"; label: string }
  | { type: "connected"; label: string };

export type RemoteVaultInputFailure =
  | { kind: "name_required" }
  | { kind: "password_mismatch" }
  | {
      kind: "invalid_password";
      validation: Extract<VaultPasswordValidation, { ok: false }>;
    };

// Carries input validation failures as codes. The user-facing message is
// formatted by the host display layer.
export class RemoteVaultInputError extends Error {
  constructor(readonly failure: RemoteVaultInputFailure) {
    super(`Invalid remote vault input: ${failure.kind}`);
    this.name = "RemoteVaultInputError";
  }
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
  notify: (event: RemoteVaultNoticeEvent) => void;
  remoteVaultClient: RemoteVaultClient;
}

export class RemoteVaultManager {
  private readonly remoteVaultClient: RemoteVaultClient;
  private session: RemoteVaultSession | null = null;

  constructor(private readonly deps: RemoteVaultManagerDeps) {
    this.remoteVaultClient = deps.remoteVaultClient;
  }

  getRemoteVaultStatus(): RemoteVaultStatus {
    if (this.session) {
      return { state: "loaded", label: formatVaultLabel(this.session.summary) };
    }

    const storedVaultId = this.deps.getStoredRemoteVaultId();
    if (storedVaultId && this.deps.getStoredRemoteVaultKeySecret()) {
      return { state: "stored_inactive" };
    }

    return { state: "not_configured" };
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
      this.notify({ type: "disconnected", label: formatStoredVaultLabel(vault) });
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
    this.notify({ type: "created_connected", label: summary.vaultName });
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
    this.notify({ type: "connected", label: summary.vaultName });
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

  private notify(event: RemoteVaultNoticeEvent): void {
    this.deps.notify(event);
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
    throw new RemoteVaultInputError({ kind: "name_required" });
  }

  const passwordValidation = validateVaultPassword(input.password);
  if (!passwordValidation.ok) {
    throw new RemoteVaultInputError({
      kind: "invalid_password",
      validation: passwordValidation,
    });
  }

  if (input.password !== input.confirmPassword) {
    throw new RemoteVaultInputError({ kind: "password_mismatch" });
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
