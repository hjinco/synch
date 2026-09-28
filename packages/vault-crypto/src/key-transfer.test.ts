import { describe, it, expect } from "vitest";
import {
  createKeyTransferReceiver,
  encryptVaultKeyForReceiver,
  decryptTransferredVaultKey,
  keyTransferVerificationCode,
} from "./key-transfer";
import {
  wrapRemoteVaultKeyWithPassword,
  unwrapRemoteVaultKeyWithPassword,
} from "./crypto";

const context = {
  requestId: "request-1",
  vaultId: "vault-1",
  userId: "alice",
  accessVersion: 1,
};
const kdfOverrides = { memoryKiB: 8, iterations: 1, parallelism: 1 };
describe("personal vault passwords and administrator key handoff", () => {
  it("shares the same data key under independent passwords and binds each wrapper to its user and vault", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const alice = await wrapRemoteVaultKeyWithPassword(
      "alice has a unique passphrase",
      key,
      { binding: { vaultId: "vault-1", userId: "alice" }, kdfOverrides },
    );
    const bob = await wrapRemoteVaultKeyWithPassword(
      "bob has another long passphrase",
      key,
      { binding: { vaultId: "vault-1", userId: "bob" }, kdfOverrides },
    );
    expect(alice.keyVersion).toBe(1);
    expect(alice.version).toBe(2);
    expect(
      await unwrapRemoteVaultKeyWithPassword(
        "alice has a unique passphrase",
        alice,
        alice.binding,
      ),
    ).toEqual(key);
    expect(
      await unwrapRemoteVaultKeyWithPassword(
        "bob has another long passphrase",
        bob,
        bob.binding,
      ),
    ).toEqual(key);
    await expect(
      unwrapRemoteVaultKeyWithPassword(
        "alice has a unique passphrase",
        bob,
        bob.binding,
      ),
    ).rejects.toThrow();
    await expect(
      unwrapRemoteVaultKeyWithPassword("alice has a unique passphrase", alice, {
        vaultId: "vault-2",
        userId: "alice",
      }),
    ).rejects.toThrow();
    await expect(
      unwrapRemoteVaultKeyWithPassword(
        "alice has a unique passphrase",
        { ...alice, binding: { vaultId: "vault-1", userId: "bob" } },
        { vaultId: "vault-1", userId: "bob" },
      ),
    ).rejects.toThrow();
    await expect(
      unwrapRemoteVaultKeyWithPassword("alice has a unique passphrase", {
        ...alice,
        version: 1,
      }),
    ).rejects.toThrow();
  });
  it("binds encrypted handoff and verification codes to the complete request context", async () => {
    const receiver = await createKeyTransferReceiver();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptVaultKeyForReceiver(
      key,
      receiver.publicKey,
      context,
    );
    expect(
      await decryptTransferredVaultKey(envelope, receiver.privateKey, context),
    ).toEqual(key);
    const code = await keyTransferVerificationCode(receiver.publicKey, context);
    expect(code).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/);
    for (const changed of [
      { ...context, userId: "bob" },
      { ...context, requestId: "new" },
      { ...context, vaultId: "other" },
      { ...context, accessVersion: 2 },
    ]) {
      expect(
        await keyTransferVerificationCode(receiver.publicKey, changed),
      ).not.toBe(code);
      await expect(
        decryptTransferredVaultKey(envelope, receiver.privateKey, changed),
      ).rejects.toThrow();
    }
    const otherReceiver = await createKeyTransferReceiver();
    await expect(
      decryptTransferredVaultKey(envelope, otherReceiver.privateKey, context),
    ).rejects.toThrow();
    expect(
      await keyTransferVerificationCode(otherReceiver.publicKey, context),
    ).not.toBe(code);
    await expect(
      decryptTransferredVaultKey(
        { ...envelope, ciphertext: "A".repeat(512) },
        receiver.privateKey,
        context,
      ),
    ).rejects.toThrow();
  });
});
