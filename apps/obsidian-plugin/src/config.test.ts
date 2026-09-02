import { describe, expect, it } from "vitest";

import {
  getDefaultApiBaseUrl,
  getServerDeployment,
  parseApiBaseUrlInput,
} from "./config";

describe("getServerDeployment", () => {
  it("treats official Synch API domains as official cloud", () => {
    expect(getServerDeployment("https://api.synch.run")).toBe("official_cloud");
    expect(getServerDeployment("https://preview.api.synch.run")).toBe(
      "official_cloud",
    );
  });

  it("treats the build-time default and other API URLs as self-hosted", () => {
    expect(getServerDeployment(getDefaultApiBaseUrl())).toBe("self_hosted");
    expect(getServerDeployment("http://localhost:8787")).toBe("self_hosted");
    expect(getServerDeployment("https://custom.synch.test")).toBe("self_hosted");
    expect(getServerDeployment(`${getDefaultApiBaseUrl()}/v1`)).toBe("self_hosted");
  });
});

describe("parseApiBaseUrlInput", () => {
  const fallback = "https://api.synch.test";

  it("adds https when the URL has no protocol", () => {
    expect(parseApiBaseUrlInput("sync.example.com", fallback)).toBe(
      "https://sync.example.com",
    );
    expect(parseApiBaseUrlInput(" localhost:8787/ ", fallback)).toBe(
      "https://localhost:8787",
    );
  });

  it("preserves an explicit http or https protocol", () => {
    expect(parseApiBaseUrlInput("http://localhost:8787", fallback)).toBe(
      "http://localhost:8787",
    );
    expect(parseApiBaseUrlInput("https://sync.example.com", fallback)).toBe(
      "https://sync.example.com",
    );
  });

  it("still rejects unsupported protocols", () => {
    expect(() => parseApiBaseUrlInput("ftp://sync.example.com", fallback)).toThrow();
    expect(() => parseApiBaseUrlInput("mailto:user@example.com", fallback)).toThrow();
  });
});
