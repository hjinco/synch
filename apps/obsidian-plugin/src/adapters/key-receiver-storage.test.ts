import { describe, expect, it, vi } from "vitest";
import { createMockPlugin } from "../test-stubs/obsidian";
import { ObsidianKeyReceiverStore } from "./key-receiver-storage";
import { getOrCreateSecretScopeId } from "./secret-scope";

describe("approval request secret storage", () => {
  const receiver = () => ({
    id: "request-id",
    privateKey: "private-key",
    publicKey: "public-key",
    expiresAt: Date.now() + 60_000,
  });

  it("persists and clears requests within Obsidian's secret ID limit", async () => {
    const plugin = createMockPlugin();
    const write = vi.spyOn(plugin.app.secretStorage, "setSecret");
    const store = new ObsidianKeyReceiverStore(plugin);
    const scope = "https://api.example.com/user/vault";
    const value = receiver();

    expect(getOrCreateSecretScopeId(plugin)).toHaveLength(36);
    await store.write(scope, value);
    expect(write.mock.calls[0]?.[0]).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(await new ObsidianKeyReceiverStore(plugin).read(scope)).toEqual(value);
    await store.write(scope, null);
    expect(await store.read(scope)).toBeNull();
  });

  it("isolates requests by remote scope and local vault on shared secret storage", async () => {
    const plugin = createMockPlugin();
    const store = new ObsidianKeyReceiverStore(plugin);
    const value = receiver();
    await store.write("remote-a", value);
    expect(await store.read("remote-b")).toBeNull();

    const originalScope = getOrCreateSecretScopeId(plugin);
    plugin.app.saveLocalStorage("synch.secretScopeId", crypto.randomUUID());
    expect(await store.read("remote-a")).toBeNull();
    await store.write("remote-a", { ...value, id: "another-request" });
    plugin.app.saveLocalStorage("synch.secretScopeId", originalScope);
    expect(await store.read("remote-a")).toEqual(value);
  });

  it("removes expired private keys", async () => {
    const plugin = createMockPlugin();
    const store = new ObsidianKeyReceiverStore(plugin);
    await store.write("remote", { ...receiver(), expiresAt: Date.now() - 1 });
    const write = vi.spyOn(plugin.app.secretStorage, "setSecret");
    expect(await store.read("remote")).toBeNull();
    expect(write).toHaveBeenCalledWith(expect.any(String), "");
  });
});
