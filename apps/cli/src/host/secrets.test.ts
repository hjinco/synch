import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliCredentialsStore } from "./secrets";

let tempDir: string;
let credentialsPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synch-secrets-"));
  credentialsPath = path.join(tempDir, "config", "credentials.json");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("CliCredentialsStore", () => {
  it("round-trips the session token via the token store", async () => {
    const store = new CliCredentialsStore(credentialsPath);
    const tokenStore = store.createSessionTokenStore();
    expect(await tokenStore.read()).toBe("");

    await tokenStore.write("session-token");
    expect(await tokenStore.read()).toBe("session-token");

    const reloaded = new CliCredentialsStore(credentialsPath);
    expect(reloaded.getSessionToken()).toBe("session-token");

    await tokenStore.clear();
    expect(await tokenStore.read()).toBe("");
  });

  it("round-trips vault credentials keyed by vault path", async () => {
    const store = new CliCredentialsStore(credentialsPath);
    const key = new Uint8Array([1, 2, 3, 4]);
    expect(store.getVaultCredential("/vaults/a")).toBeNull();

    await store.saveVaultCredential("/vaults/a", "vault-1", {
      remoteVaultKey: key,
    });

    const reloaded = new CliCredentialsStore(credentialsPath);
    const credential = reloaded.getVaultCredential("/vaults/a");
    expect(credential?.remoteVaultId).toBe("vault-1");
    expect([...(credential?.secret.remoteVaultKey ?? [])]).toEqual([1, 2, 3, 4]);
    expect(reloaded.getVaultCredential("/vaults/b")).toBeNull();
  });

  it("clears individual and all vault credentials", async () => {
    const store = new CliCredentialsStore(credentialsPath);
    const key = new Uint8Array([7]);
    await store.saveVaultCredential("/vaults/a", "vault-1", { remoteVaultKey: key });
    await store.saveVaultCredential("/vaults/b", "vault-2", { remoteVaultKey: key });

    await store.clearVaultCredential("/vaults/a");
    expect(store.getVaultCredential("/vaults/a")).toBeNull();
    expect(store.getVaultCredential("/vaults/b")).not.toBeNull();

    await store.clearAllVaultCredentials();
    expect(store.getVaultCredential("/vaults/b")).toBeNull();
  });

  it("writes the credentials file with owner-only permissions", async () => {
    const store = new CliCredentialsStore(credentialsPath);
    await store.setSessionToken("secret");

    const fileMode = fs.statSync(credentialsPath).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = fs.statSync(path.dirname(credentialsPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("preserves a corrupted file as a backup and starts fresh", () => {
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, "not json");

    const store = new CliCredentialsStore(credentialsPath);
    expect(store.getSessionToken()).toBe("");

    expect(fs.existsSync(credentialsPath)).toBe(false);
    const backups = fs
      .readdirSync(path.dirname(credentialsPath))
      .filter((name) => name.startsWith("credentials.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(path.dirname(credentialsPath), backups[0]), "utf8"),
    ).toBe("not json");
  });
});
