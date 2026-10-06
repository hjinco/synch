import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiBaseUrl } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("resolveApiBaseUrl", () => {
  it("prefers the flag, then environment, then stored login URL", () => {
    vi.stubEnv("SYNCH_API_URL", "https://env.example/");
    expect(resolveApiBaseUrl(" https://flag.example/ ", "https://vault.example")).toBe("https://flag.example");
    expect(resolveApiBaseUrl(undefined, "https://vault.example")).toBe("https://env.example");
    vi.stubEnv("SYNCH_API_URL", "");
    expect(resolveApiBaseUrl(undefined, "https://vault.example/")).toBe("https://vault.example");
  });

  it("keeps the previous default for credentials without a URL", () => {
    vi.stubEnv("SYNCH_API_URL", "");
    expect(resolveApiBaseUrl()).toBe("http://127.0.0.1:8787");
  });

  it("rejects invalid URLs instead of silently falling back", () => {
    vi.stubEnv("SYNCH_API_URL", "");
    expect(() => resolveApiBaseUrl("ftp://flag.example", "https://vault.example")).toThrow("Invalid API base URL");
    expect(() => resolveApiBaseUrl(undefined, "https://vault.example/?query=1")).toThrow("Invalid API base URL");
    vi.stubEnv("SYNCH_API_URL", "invalid");
    expect(() => resolveApiBaseUrl(undefined, "https://vault.example")).toThrow("Invalid API base URL");
  });
});
