import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CliCredentialsStore } from "../host/secrets";
import { SqliteSyncStore } from "../host/sqlite-store";
import { SyncContentRuntime } from "@synch/sync-client/core";
import { CliAppContext } from "./context";

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synch-context-"));
  vi.stubEnv("SYNCH_API_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("restores the login API URL regardless of the vault directory before initializing clients", async () => {
  const credentialsPath = path.join(tempDir, "credentials.json");
  const vaultPath = path.join(tempDir, "vault");
  const credentials = new CliCredentialsStore(credentialsPath);
  await credentials.saveVaultCredential(vaultPath, "vault-1", {
    remoteVaultKey: new Uint8Array(32),
  });
  await credentials.setSessionToken("session-token", "https://login.example");

  const ctx = new CliAppContext({ vaultPath, credentialsPath });
  try {
    expect(ctx.apiBaseUrl).toBe("https://login.example");
    expect(ctx.hasStoredVaultCredential()).toBe(true);
  } finally {
    await ctx.close();
  }

  const otherVault = new CliAppContext({ vaultPath: path.join(tempDir, "other"), credentialsPath });
  try {
    expect(otherVault.apiBaseUrl).toBe("https://login.example");
  } finally {
    await otherVault.close();
  }

  const override = new CliAppContext({ vaultPath, credentialsPath, apiBaseUrl: "https://override.example" });
  try {
    expect(override.apiBaseUrl).toBe("https://override.example");
    expect(override.credentials.getSessionApiBaseUrl()).toBe("https://login.example");
    expect(await override.credentials.createSessionTokenStore(override.apiBaseUrl).read()).toBe("");
  } finally {
    await override.close();
  }
});

it("binds a legacy session URL only after successful verification", async () => {
  const credentialsPath = path.join(tempDir, "credentials.json");
  const credentials = new CliCredentialsStore(credentialsPath);
  await credentials.setSessionToken("legacy-token");
  const ctx = new CliAppContext({ vaultPath: tempDir, credentialsPath, apiBaseUrl: "https://api.example" });
  vi.spyOn(ctx.authManager, "initialize").mockResolvedValue(undefined);
  vi.spyOn(ctx.authManager, "getReadiness").mockReturnValue({ state: "anonymous" });
  try {
    await ctx.initializeAuth();
    expect(ctx.credentials.getSessionApiBaseUrl()).toBeUndefined();
    vi.spyOn(ctx.authManager, "getReadiness").mockReturnValue({ state: "verified", token: "legacy-token" });
    vi.spyOn(ctx.authManager, "getAuthSessionToken").mockReturnValue("legacy-token");
    await ctx.initializeAuth();
    expect(new CliCredentialsStore(credentialsPath).getSessionApiBaseUrl()).toBe("https://api.example");
  } finally {
    await ctx.close();
  }
});

it("finishes queued local writes before closing the store and disposes the content runtime", async () => {
  const ctx = new CliAppContext({
    vaultPath: tempDir,
    credentialsPath: path.join(tempDir, "credentials.json"),
  });
  const dbPath = path.join(tempDir, "sync.sqlite");
  const store = SqliteSyncStore.open(dbPath);
  ctx.engine.setStore(store);
  const read = Promise.withResolvers<Uint8Array>();
  const reading = Promise.withResolvers<void>();
  const dispose = vi.spyOn(SyncContentRuntime.prototype, "dispose");
  const closeStore = vi.spyOn(ctx.engine, "closeStore");
  vi.spyOn(ctx, "getActiveRemoteVaultKey").mockReturnValue(new Uint8Array(32).fill(7));
  vi.spyOn(ctx.vaultAdapter, "listFiles").mockResolvedValue([{
    path: "note.md", mtime: 1, size: 4,
    readBytes: () => { reading.resolve(); return read.promise; },
  }]);

  const reconcile = ctx.engine.reconcileOnce();
  await reading.promise;
  const closing = ctx.close();
  try {
    expect(closeStore).not.toHaveBeenCalled();
  } finally {
    read.resolve(new TextEncoder().encode("note"));
    await Promise.allSettled([closing, reconcile]);
  }
  await closing;
  await expect(reconcile).resolves.toMatchObject({ filesQueuedForUpsert: 1 });
  expect(dispose).toHaveBeenCalledTimes(1);

  const reopened = SqliteSyncStore.open(dbPath);
  try {
    expect(await reopened.listDirtyEntries()).toMatchObject([{ op: "upsert" }]);
    expect(await reopened.getLocalStateByPath("note.md")).toMatchObject({ deleted: false });
  } finally {
    await reopened.close();
  }
});
