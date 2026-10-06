import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CliCredentialsStore } from "../host/secrets";
import { CliAppContext } from "./context";

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synch-context-"));
  vi.stubEnv("SYNCH_API_URL", "");
});
afterEach(() => {
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
    vi.spyOn(ctx.authManager, "getReadiness").mockReturnValue({ state: "verified" });
    vi.spyOn(ctx.authManager, "getAuthSessionToken").mockReturnValue("legacy-token");
    await ctx.initializeAuth();
    expect(new CliCredentialsStore(credentialsPath).getSessionApiBaseUrl()).toBe("https://api.example");
  } finally {
    await ctx.close();
  }
});
