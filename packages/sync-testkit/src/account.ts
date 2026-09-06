import { createPasswordWrappedRemoteVaultKey, unwrapRemoteVaultKeyWithPassword, type RemoteVaultKeyEnvelope } from "@synch/vault-crypto";
import type { SyncTokenResponse } from "@synch/sync-client/remote";
import { testEmail } from "./server";

export async function signUp(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: testEmail, password: "sync e2e account password", name: "Sync E2E" }),
  });
  if (!response.ok) throw new Error(`Signup: ${response.status} ${await response.text()}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Signup did not issue a session");
  return cookie;
}

export async function createVault(baseUrl: string, cookie: string) {
  const password = "sync e2e vault password";
  const wrapped = await createPasswordWrappedRemoteVaultKey(password);
  const headers = { "content-type": "application/json", origin: baseUrl, cookie };
  const response = await fetch(`${baseUrl}/v1/vaults`, {
    method: "POST", headers,
    body: JSON.stringify({ name: crypto.randomUUID(), initialWrapper: { kind: "password", envelope: wrapped.envelope } }),
  });
  if (!response.ok) throw new Error(`Create vault: ${response.status} ${await response.text()}`);
  const { vault } = await response.json() as { vault: { id: string } };
  return attachVault(baseUrl, cookie, vault.id, wrapped.remoteVaultKey);
}

/** Reattach a local test client to an already provisioned vault. */
export function attachVault(baseUrl: string, cookie: string, vaultId: string, key: Uint8Array) {
  const password = "sync e2e vault password";
  const headers = { "content-type": "application/json", origin: baseUrl, cookie };
  return {
    id: vaultId, key,
    async unlock() {
      const response = await fetch(`${baseUrl}/v1/vaults/${vaultId}/bootstrap`, { headers });
      if (!response.ok) throw new Error(`Bootstrap: ${response.status}`);
      const body = await response.json() as { wrappers: { envelope: RemoteVaultKeyEnvelope }[] };
      return unwrapRemoteVaultKeyWithPassword(password, body.wrappers[0].envelope);
    },
    async token(localVaultId: string): Promise<SyncTokenResponse> {
      const response = await fetch(`${baseUrl}/v1/sync/token`, {
        method: "POST", headers, body: JSON.stringify({ vaultId, localVaultId }),
      });
      if (!response.ok) throw new Error(`Token: ${response.status} ${await response.text()}`);
      return response.json() as Promise<SyncTokenResponse>;
    },
  };
}
export type TestVault = Awaited<ReturnType<typeof createVault>>;
