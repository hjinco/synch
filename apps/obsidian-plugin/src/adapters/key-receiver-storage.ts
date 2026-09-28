import type { Plugin } from "obsidian";
import type {
  KeyReceiverStore,
  StoredKeyReceiver,
} from "@synch/sync-client/remote";
import { getOrCreateSecretScopeId } from "./secret-scope";

/** Request private keys belong in Obsidian's secret storage, never plugin data.json. */
export class ObsidianKeyReceiverStore implements KeyReceiverStore {
  constructor(private readonly plugin: Plugin) {}
  private async name(scope: string): Promise<string> {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope)),
    );
    const suffix = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `synch-key-request-${getOrCreateSecretScopeId(this.plugin)}-${suffix}`;
  }
  async read(scope: string): Promise<StoredKeyReceiver | null> {
    const name = await this.name(scope);
    const raw = this.plugin.app.secretStorage.getSecret(name);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredKeyReceiver;
    if (
      typeof value.id !== "string" ||
      typeof value.privateKey !== "string" ||
      typeof value.publicKey !== "string" ||
      !Number.isFinite(value.expiresAt)
    )
      throw new Error("Invalid stored key request");
    if (value.expiresAt <= Date.now()) {
      this.plugin.app.secretStorage.setSecret(name, "");
      return null;
    }
    return value;
  }
  async write(scope: string, value: StoredKeyReceiver | null): Promise<void> {
    this.plugin.app.secretStorage.setSecret(
      await this.name(scope),
      value ? JSON.stringify(value) : "",
    );
  }
}
