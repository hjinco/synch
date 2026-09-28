import { describe, expect, it, vi } from "vitest";
import { RemoteVaultClient } from "./client";
import { RemoteVaultManager } from "./manager";
import type { HttpResponseLike } from "../http/request";

function managerFor(response: HttpResponseLike) {
  const request = vi.fn(async () => response);
  const manager = new RemoteVaultManager({
    getApiBaseUrl: () => "https://server.example",
    getAuthSessionToken: () => "token",
    hasAuthenticatedSession: () => true,
    getStoredRemoteVaultId: () => null,
    getStoredRemoteVaultKeySecret: () => null,
    saveStoredRemoteVaultKeySecret: async () => {},
    refreshUi: () => {}, notify: () => {},
    remoteVaultClient: new RemoteVaultClient({ request }),
  });
  return manager;
}

describe("vault creation organization discovery", () => {
  it("uses the default organization on older servers", async () => {
    await expect(managerFor({ status: 404 }).listCreatableOrganizations()).resolves.toEqual([]);
  });

  it.each([401, 403, 503])("does not hide authentication or availability errors (%s)", async status => {
    await expect(managerFor({ status }).listCreatableOrganizations()).rejects.toMatchObject({ status });
  });

  it("only offers organizations the user can manage on newer servers", async () => {
    const organizations = [
      { id: "owned", name: "Personal", role: "owner" },
      { id: "admin", name: "Team", role: "admin" },
      { id: "member", name: "Other", role: "member" },
    ];
    await expect(managerFor({ status: 200, json: { organizations } }).listCreatableOrganizations())
      .resolves.toEqual(organizations.slice(0, 2));
  });
});
