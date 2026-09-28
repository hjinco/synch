import { describe, expect, it, vi } from "vitest";
import { SharingManager, type StoredKeyReceiver } from "./manager";
import type { SharingClient, VaultKeyRequest } from "./client";

describe("recipient key verification", () => {
  it("rejects a server-substituted public key and a request without a local receiver", async () => {
    const receiver: StoredKeyReceiver = {
      id: "request",
      publicKey: "local key",
      privateKey: "private",
      expiresAt: Date.now() + 60000,
    };
    const request = {
      id: "request",
      vaultId: "vault",
      userId: "user",
      publicKey: "server substituted key",
      expiresAt: receiver.expiresAt,
      status: "pending",
    } as VaultKeyRequest;
    const client = {
      apiBaseUrl: "https://api.example.com",
      getRequest: vi.fn(async () => request),
    } as unknown as SharingClient;
    let saved: StoredKeyReceiver | null = receiver;
    const manager = new SharingManager(client, "user", {
      read: async () => saved,
      write: async () => {},
    });
    await expect(manager.recipientVerificationCode("vault")).rejects.toThrow(
      "does not match",
    );
    saved = null;
    await expect(manager.recipientVerificationCode("vault")).rejects.toThrow(
      "this device",
    );
    expect(client.getRequest).toHaveBeenCalledTimes(1);
  });
});
