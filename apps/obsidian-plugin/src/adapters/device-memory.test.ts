import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { getSyncMemoryBudget } from "./device-memory";

const original = { ...Platform };
afterEach(() => { Object.assign(Platform, original); vi.unstubAllGlobals(); });

describe("device RAM detection", () => {
  it("prefers Electron RAM on desktop and converts KiB to bytes", () => {
    Object.assign(Platform, { isDesktop: true, isMobile: false });
    vi.stubGlobal("window", { process: { getSystemMemoryInfo: () => ({ total: 16 * 1024 ** 2 }) } });
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    expect(getSyncMemoryBudget()).toBe(Math.floor(16 * 1024 ** 3 * 0.2));
  });
  it("uses the browser signal on mobile without consulting Electron", () => {
    Object.assign(Platform, { isDesktop: false, isMobile: true });
    const getSystemMemoryInfo = vi.fn();
    vi.stubGlobal("window", { process: { getSystemMemoryInfo } });
    vi.stubGlobal("navigator", { deviceMemory: 8 });
    expect(getSyncMemoryBudget()).toBe(Math.floor(8 * 1024 ** 3 * 0.1));
    expect(getSystemMemoryInfo).not.toHaveBeenCalled();
  });
  it("falls back when host RAM APIs are missing or throw", () => {
    Object.assign(Platform, { isDesktop: true, isMobile: false });
    vi.stubGlobal("window", { process: { getSystemMemoryInfo: () => { throw new Error("unavailable"); } } });
    vi.stubGlobal("navigator", {});
    expect(getSyncMemoryBudget()).toBe(512 * 1024 ** 2);
    Object.assign(Platform, { isDesktop: false, isMobile: true });
    expect(getSyncMemoryBudget()).toBe(128 * 1024 ** 2);
  });
});
