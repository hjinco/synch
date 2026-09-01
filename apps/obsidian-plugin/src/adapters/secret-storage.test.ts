import { describe, expect, it } from "vitest";

import type { Plugin } from "obsidian";

import { encodeBase64 } from "@synch/vault-crypto";
import {
  clearAuthSessionToken,
  migrateLegacyAuthSessionToken,
  ObsidianAuthSessionTokenStore,
} from "./auth-session-storage";
import { clearLocalVaultId } from "./dexie-store/local-vault";
import {
  clearStoredRemoteVaultKeySecret,
  migrateLegacyRemoteVaultKeySecret,
  readStoredRemoteVaultKeySecret,
  writeStoredRemoteVaultKeySecret,
} from "./remote-vault-device-storage";
import { getOrCreateSecretScopeId } from "./secret-scope";
import { SynchPluginSessionStore } from "../app/session-store";
import { Plugin as TestPluginClass } from "../test-stubs/obsidian";

const TestPlugin = TestPluginClass as unknown as new () => Plugin;

describe("vault-scoped secret storage", () => {
  it("stores remote vault keys separately for each vault", async () => {
    const pluginA = createPlugin("scope-a");
    const pluginB = createPlugin("scope-b");
    const keyA = new Uint8Array([1, 2, 3]);
    const keyB = new Uint8Array([4, 5, 6]);
    pluginA.app.secretStorage.setSecret(
      "synch-remote-vault-key",
      encodeBase64(new Uint8Array([9, 8, 7])),
    );

    await writeStoredRemoteVaultKeySecret(pluginA, { remoteVaultKey: keyA });
    await writeStoredRemoteVaultKeySecret(pluginB, { remoteVaultKey: keyB });

    expect(
      pluginA.app.secretStorage.getSecret("synch-remote-vault-key-scope-a"),
    ).toBe(encodeBase64(keyA));
    expect(
      pluginB.app.secretStorage.getSecret("synch-remote-vault-key-scope-b"),
    ).toBe(encodeBase64(keyB));
    expect(pluginA.app.secretStorage.getSecret("synch-remote-vault-key")).toBe(
      "",
    );
    await expect(readStoredRemoteVaultKeySecret(pluginA)).resolves.toEqual({
      remoteVaultKey: keyA,
    });
    await expect(readStoredRemoteVaultKeySecret(pluginB)).resolves.toEqual({
      remoteVaultKey: keyB,
    });
  });

  it("only reads the scoped remote vault key after startup migration", async () => {
    const plugin = createPlugin("scope-a");
    const key = new Uint8Array([1, 2, 3]);
    const encodedKey = encodeBase64(key);
    plugin.app.secretStorage.setSecret("synch-remote-vault-key", encodedKey);

    await expect(readStoredRemoteVaultKeySecret(plugin)).resolves.toBeNull();
    expect(
      plugin.app.secretStorage.getSecret("synch-remote-vault-key-scope-a"),
    ).toBeUndefined();

    await migrateLegacyRemoteVaultKeySecret(plugin);
    await expect(readStoredRemoteVaultKeySecret(plugin)).resolves.toEqual({
      remoteVaultKey: key,
    });
    expect(
      plugin.app.secretStorage.getSecret("synch-remote-vault-key-scope-a"),
    ).toBe(encodedKey);
    expect(plugin.app.secretStorage.getSecret("synch-remote-vault-key")).toBe(
      "",
    );
  });

  it("does not resurrect a cleared remote key from the legacy slot", async () => {
    const plugin = createPlugin("scope-a");
    const key = new Uint8Array([1, 2, 3]);
    const encodedKey = encodeBase64(key);
    plugin.app.secretStorage.setSecret("synch-remote-vault-key", encodedKey);

    await migrateLegacyRemoteVaultKeySecret(plugin);
    await clearStoredRemoteVaultKeySecret(plugin);

    await migrateLegacyRemoteVaultKeySecret(plugin);
    await expect(readStoredRemoteVaultKeySecret(plugin)).resolves.toBeNull();
    expect(plugin.app.secretStorage.getSecret("synch-remote-vault-key")).toBe("");
  });

  it("migrates the legacy remote key without a stored sync connection", async () => {
    const plugin = createPlugin("scope-a");
    const key = new Uint8Array([1, 2, 3]);
    plugin.app.secretStorage.setSecret(
      "synch-remote-vault-key",
      encodeBase64(key),
    );

    await migrateLegacyRemoteVaultKeySecret(plugin);

    expect(await readStoredRemoteVaultKeySecret(plugin)).toEqual({
      remoteVaultKey: key,
    });
  });

  it("migrates both legacy credentials during startup migration", async () => {
    const plugin = createPlugin("scope-a");
    const key = new Uint8Array([1, 2, 3]);
    plugin.app.secretStorage.setSecret("synch-session-token", "legacy-token");
    plugin.app.secretStorage.setSecret(
      "synch-remote-vault-key",
      encodeBase64(key),
    );
    const sessionStore = new SynchPluginSessionStore({
      plugin,
      refreshUi: () => {},
    });

    await sessionStore.migrateLegacySecrets();

    expect(plugin.app.secretStorage.getSecret("synch-session-token")).toBe("");
    expect(plugin.app.secretStorage.getSecret("synch-remote-vault-key")).toBe("");

    await expect(new ObsidianAuthSessionTokenStore(plugin).read()).resolves.toBe(
      "legacy-token",
    );
    await sessionStore.loadStoredRemoteVaultKeySecret();
    expect(sessionStore.getStoredRemoteVaultKeySecret()).toEqual({
      remoteVaultKey: key,
    });
  });

  it("stores and migrates session tokens per vault", async () => {
    const pluginA = createPlugin("scope-a");
    const pluginB = createPlugin("scope-b");
    const storeA = new ObsidianAuthSessionTokenStore(pluginA);
    const storeB = new ObsidianAuthSessionTokenStore(pluginB);
    pluginA.app.secretStorage.setSecret("synch-session-token", "legacy-token");

    await storeA.write(" token-a ");
    await storeB.write(" token-b ");

    expect(
      pluginA.app.secretStorage.getSecret("synch-session-token-scope-a"),
    ).toBe("token-a");
    expect(
      pluginB.app.secretStorage.getSecret("synch-session-token-scope-b"),
    ).toBe("token-b");
    expect(pluginA.app.secretStorage.getSecret("synch-session-token")).toBe("");
    await expect(storeA.read()).resolves.toBe("token-a");
    await expect(storeB.read()).resolves.toBe("token-b");
  });

  it("migrates a legacy session token and does not restore it after clear", async () => {
    const plugin = createPlugin("scope-a");
    const store = new ObsidianAuthSessionTokenStore(plugin);
    plugin.app.secretStorage.setSecret("synch-session-token", "legacy-token");

    await expect(store.read()).resolves.toBe("");
    await migrateLegacyAuthSessionToken(plugin);
    await expect(store.read()).resolves.toBe("legacy-token");
    expect(
      plugin.app.secretStorage.getSecret("synch-session-token-scope-a"),
    ).toBe("legacy-token");

    await clearAuthSessionToken(plugin);

    await expect(store.read()).resolves.toBe("");
    expect(plugin.app.secretStorage.getSecret("synch-session-token")).toBe("");
  });

  it("keeps the secret scope when the sync local vault id is reset", () => {
    const plugin = new TestPlugin();
    const secretScopeId = getOrCreateSecretScopeId(plugin);

    clearLocalVaultId(plugin);

    expect(getOrCreateSecretScopeId(plugin)).toBe(secretScopeId);
  });
});

function createPlugin(secretScopeId: string): Plugin {
  const plugin = new TestPlugin();
  plugin.app.saveLocalStorage("synch.secretScopeId", secretScopeId);
  return plugin;
}
