import { describe, expect, it } from "vitest";

import { buildBillingWebPageUrl } from "./billing-web-url";

describe("billing web URL helpers", () => {
  it("maps Synch API hosts to the Synch website", () => {
    expect(buildBillingWebPageUrl("https://api.synch.run", "billing", "en")).toBe(
      "https://synch.run/billing",
    );
    expect(buildBillingWebPageUrl("https://preview.api.synch.run", "pricing", "en")).toBe(
      "https://synch.run/pricing",
    );
  });

  it("maps local worker URLs to the local website dev server", () => {
    expect(buildBillingWebPageUrl("http://127.0.0.1:8787", "billing", "en")).toBe(
      "http://localhost:4321/billing",
    );
    expect(buildBillingWebPageUrl("http://localhost:8787", "pricing", "en")).toBe(
      "http://localhost:4321/pricing",
    );
  });

  it("uses localized paths for Korean", () => {
    expect(buildBillingWebPageUrl("https://api.synch.run", "billing", "ko")).toBe(
      "https://synch.run/ko/billing",
    );
    expect(buildBillingWebPageUrl("https://api.synch.run", "pricing", "ko")).toBe(
      "https://synch.run/ko/pricing",
    );
  });

  it("uses localized paths for Japanese, Chinese, and German", () => {
    expect(buildBillingWebPageUrl("https://api.synch.run", "billing", "ja")).toBe(
      "https://synch.run/ja/billing",
    );
    expect(buildBillingWebPageUrl("https://api.synch.run", "pricing", "zh-cn")).toBe(
      "https://synch.run/zh-cn/pricing",
    );
    expect(buildBillingWebPageUrl("https://api.synch.run", "billing", "zh-tw")).toBe(
      "https://synch.run/zh-tw/billing",
    );
    expect(buildBillingWebPageUrl("https://api.synch.run", "pricing", "de")).toBe(
      "https://synch.run/de/pricing",
    );
  });
});
