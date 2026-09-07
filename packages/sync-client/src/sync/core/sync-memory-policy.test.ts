import { describe, expect, it } from "vitest";
import { resolveSyncMemoryBudget } from "./sync-memory-policy";

describe("source-byte memory policy", () => {
  it("uses 20% on desktop and 10% on mobile without a fixed cap", () => {
    const totalMemoryBytes = 32 * 1024 ** 3;
    expect(resolveSyncMemoryBudget({ totalMemoryBytes, isMobile: false })).toBe(Math.floor(totalMemoryBytes * 0.2));
    expect(resolveSyncMemoryBudget({ totalMemoryBytes, isMobile: true })).toBe(Math.floor(totalMemoryBytes * 0.1));
  });
  it.each([undefined, NaN, Infinity, 0, -1])("falls back when RAM is unavailable (%s)", (totalMemoryBytes) => {
    expect(resolveSyncMemoryBudget({ totalMemoryBytes, isMobile: false })).toBe(512 * 1024 ** 2);
    expect(resolveSyncMemoryBudget({ totalMemoryBytes, isMobile: true })).toBe(128 * 1024 ** 2);
  });
});
