import {
  createKeyTransferReceiver,
  keyTransferVerificationCode,
  encryptVaultKeyForReceiver,
  decryptTransferredVaultKey,
  wrapRemoteVaultKeyWithPassword,
  unwrapRemoteVaultKeyWithPassword,
  validateVaultPassword,
  type RemoteVaultKeyEnvelope,
  type KeyTransferEnvelope,
  type KeyTransferContext,
} from "@synch/vault-crypto";
import { SharingClient, type VaultKeyRequest } from "./client";

export interface StoredKeyReceiver {
  id: string;
  publicKey: string;
  privateKey: string;
  expiresAt: number;
  /** Persist the exact wrapper before completing so a lost response is safely retryable. */
  preparedEnvelope?: RemoteVaultKeyEnvelope;
}
export interface KeyReceiverStore {
  read(scope: string): Promise<StoredKeyReceiver | null>;
  write(scope: string, value: StoredKeyReceiver | null): Promise<void>;
}

export class SharingManager {
  constructor(
    readonly client: SharingClient,
    readonly userId: string,
    private readonly secrets: KeyReceiverStore,
  ) {}
  private scope(vaultId: string) {
    return JSON.stringify([this.client.apiBaseUrl, this.userId, vaultId]);
  }
  private context(request: VaultKeyRequest): KeyTransferContext {
    return {
      requestId: request.id,
      vaultId: request.vaultId,
      userId: request.userId,
      accessVersion: request.accessVersion,
    };
  }
  async localRequest(vaultId: string): Promise<VaultKeyRequest | null> {
    const receiver = await this.secrets.read(this.scope(vaultId));
    if (!receiver || receiver.expiresAt <= Date.now()) return null;
    const request = await this.client.getRequest(vaultId, receiver.id);
    this.verifyRecipient(request, vaultId, receiver);
    return request;
  }
  async begin(vaultId: string): Promise<VaultKeyRequest> {
    const scope = this.scope(vaultId);
    let receiver = await this.secrets.read(scope);
    if (!receiver || receiver.expiresAt <= Date.now()) {
      receiver = {
        id: crypto.randomUUID(),
        ...(await createKeyTransferReceiver()),
        expiresAt: Date.now() + 48 * 60 * 60 * 1000,
      };
      // Persist before sending. A network error must not orphan the private key.
      await this.secrets.write(scope, receiver);
    }
    const request = await this.client.start(
      vaultId,
      receiver.id,
      receiver.publicKey,
    );
    this.verifyRecipient(request, vaultId, receiver);
    if (request.status === "canceled" || request.expiresAt <= Date.now()) {
      await this.secrets.write(scope, null);
      throw new Error(
        "The request expired or was canceled. Start a new request.",
      );
    }
    return request;
  }
  async restart(vaultId: string): Promise<VaultKeyRequest> {
    await this.secrets.write(this.scope(vaultId), null);
    return this.begin(vaultId);
  }
  async verificationCode(request: VaultKeyRequest): Promise<string> {
    return keyTransferVerificationCode(
      request.publicKey,
      this.context(request),
    );
  }
  async recipientVerificationCode(vaultId: string): Promise<string> {
    const request = await this.localRequest(vaultId);
    if (
      !request ||
      request.status === "canceled" ||
      request.expiresAt <= Date.now()
    )
      throw new Error("Start a new request on this device.");
    return this.verificationCode(request);
  }
  async approve(
    request: VaultKeyRequest,
    remoteVaultKey: Uint8Array,
    recipientCode: string,
  ): Promise<void> {
    if (
      request.userId === this.userId ||
      request.status !== "pending" ||
      request.expiresAt <= Date.now()
    )
      throw new Error("This key request cannot be approved.");
    const expected = await this.verificationCode(request);
    if (recipientCode.trim().toLowerCase() !== expected)
      throw new Error(
        "The verification code does not match. Contact the recipient through a separate channel.",
      );
    const envelope = await encryptVaultKeyForReceiver(
      remoteVaultKey,
      request.publicKey,
      this.context(request),
    );
    await this.client.approve(request, envelope);
  }
  async receive(
    vaultId: string,
    password: string,
    confirmPassword: string,
  ): Promise<void> {
    this.validatePassword(password, confirmPassword);
    const scope = this.scope(vaultId);
    const receiver = await this.secrets.read(scope);
    if (!receiver || receiver.expiresAt <= Date.now())
      throw new Error("Start a new request on this device.");
    const request = await this.client.getRequest(vaultId, receiver.id);
    this.verifyRecipient(request, vaultId, receiver);
    if (
      request.expiresAt <= Date.now() ||
      !["approved", "completed"].includes(request.status)
    )
      throw new Error(
        "Administrator approval is still required, or the request expired.",
      );
    let key: Uint8Array;
    if (receiver.preparedEnvelope) {
      key = await unwrapRemoteVaultKeyWithPassword(
        password,
        receiver.preparedEnvelope,
        { vaultId, userId: this.userId },
      );
    } else {
      if (!request.envelopeJson || request.status !== "approved")
        throw new Error("Start a new request on this device.");
      key = await decryptTransferredVaultKey(
        JSON.parse(request.envelopeJson) as KeyTransferEnvelope,
        receiver.privateKey,
        this.context(request),
      );
    }
    try {
      if (!receiver.preparedEnvelope) {
        receiver.preparedEnvelope = await wrapRemoteVaultKeyWithPassword(
          password,
          key,
          { binding: { vaultId, userId: this.userId } },
        );
        await this.secrets.write(scope, receiver);
      }
      await this.client.complete(request, receiver.preparedEnvelope);
      await this.secrets.write(scope, null);
    } finally {
      key.fill(0);
    }
  }
  async changePassword(
    vaultId: string,
    key: Uint8Array,
    password: string,
    confirmPassword: string,
  ): Promise<void> {
    this.validatePassword(password, confirmPassword);
    const envelope = await wrapRemoteVaultKeyWithPassword(password, key, {
      binding: { vaultId, userId: this.userId },
    });
    await this.client.changePassword(vaultId, envelope);
  }
  private verifyRecipient(
    request: VaultKeyRequest,
    vaultId: string,
    receiver: StoredKeyReceiver,
  ) {
    if (
      request.id !== receiver.id ||
      request.userId !== this.userId ||
      request.vaultId !== vaultId ||
      request.publicKey !== receiver.publicKey
    )
      throw new Error(
        "The key request does not match this device and account.",
      );
  }
  private validatePassword(password: string, confirmPassword: string) {
    if (password !== confirmPassword)
      throw new Error("Passwords do not match.");
    const result = validateVaultPassword(password);
    if (!result.ok) throw new Error(result.message);
  }
}
