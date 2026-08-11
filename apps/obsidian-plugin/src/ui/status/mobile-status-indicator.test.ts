import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import { SynchMobileStatusIndicator } from "./mobile-status-indicator";
import type { SynchStorageStatus, SynchSyncState } from "../contracts";

class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  classes = new Set<string>();
  removed = false;
  private eventListeners = new Map<string, Array<() => void>>();

  addClass(value: string): void {
    this.classes.add(value);
  }

  removeClass(value: string): void {
    this.classes.delete(value);
  }

  toggleClass(value: string, enabled: boolean): void {
    if (enabled) {
      this.classes.add(value);
      return;
    }

    this.classes.delete(value);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  createEl(_tag: string, options?: { cls?: string }): FakeElement {
    const element = new FakeElement();
    if (options?.cls) {
      element.addClass(options.cls);
    }
    this.children.push(element);
    return element;
  }

  addEventListener(type: string, callback: () => void): void {
    this.eventListeners.set(type, [...(this.eventListeners.get(type) ?? []), callback]);
  }

  click(): void {
    for (const callback of this.eventListeners.get("click") ?? []) {
      callback();
    }
  }

  remove(): void {
    this.removed = true;
  }
}

function createPlugin(): Plugin & {
  cleanupCallbacks: Array<() => void>;
  openedSettings: string[];
} {
  const cleanupCallbacks: Array<() => void> = [];
  const openedSettings: string[] = [];

  return {
    cleanupCallbacks,
    openedSettings,
    app: {
      setting: {
        open: () => {
          openedSettings.push("open");
        },
        openTabById: (id: string) => {
          openedSettings.push(id);
        },
      },
    },
    manifest: {
      id: "synch",
    },
    register: (callback: () => void) => {
      cleanupCallbacks.push(callback);
    },
    registerDomEvent: (element: FakeElement, type: string, callback: () => void) => {
      element.addEventListener(type, callback);
    },
  } as unknown as Plugin & {
    cleanupCallbacks: Array<() => void>;
    openedSettings: string[];
  };
}

function createState(
  syncState: SynchSyncState,
  percent = 0,
  storageStatus: SynchStorageStatus | null = null,
) {
  return {
    getSyncState: () => syncState,
    getSyncPercent: () => percent,
    getStorageStatus: () => storageStatus,
  };
}

describe("SynchMobileStatusIndicator", () => {
  it("shows the indicator when sync needs attention", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("attention_needed", 0),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();

    const item = rootEl.children[0];
    expect(item.classes).toContain("synch-mobile-status-indicator");
    expect(item.classes).toContain("synch-status-attention-needed");
    expect(item.classes.has("synch-mobile-status-indicator-hidden")).toBe(false);
    expect(item.attributes.get("aria-label")).toBe(
      "Synch needs attention. Open Synch settings",
    );
    expect(item.attributes.get("data-synch-sync-state")).toBe("attention_needed");
    expect(item.attributes.get("data-synch-storage-warning")).toBe("false");
    expect(item.children[0].attributes.get("data-icon")).toBe("triangle-alert");
  });

  it("shows storage warnings even when sync is up to date", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("up_to_date", 100, {
        storageUsedBytes: 95,
        storageLimitBytes: 100,
      }),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();

    const item = rootEl.children[0];
    expect(item.classes).toContain("synch-status-storage-warning");
    expect(item.classes.has("synch-mobile-status-indicator-hidden")).toBe(false);
    expect(item.attributes.get("aria-label")).toBe(
      "Synch storage is almost full. Open Synch settings",
    );
    expect(item.attributes.get("data-synch-sync-state")).toBe("up_to_date");
    expect(item.attributes.get("data-synch-storage-warning")).toBe("true");
  });

  it("shows the indicator when a plugin update is required", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("update_required", 0),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();

    const item = rootEl.children[0];
    expect(item.classes).toContain("synch-status-update-required");
    expect(item.classes.has("synch-mobile-status-indicator-hidden")).toBe(false);
    expect(item.attributes.get("aria-label")).toBe(
      "Synch plugin update required. Open Synch settings",
    );
    expect(item.attributes.get("data-synch-sync-state")).toBe("update_required");
    expect(item.children[0].attributes.get("data-icon")).toBe("triangle-alert");
  });

  it("hides the indicator for normal states", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("up_to_date", 100),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();

    const item = rootEl.children[0];
    expect(item.classes).toContain("synch-mobile-status-indicator-hidden");
    expect(item.attributes.get("data-synch-sync-state")).toBe("up_to_date");
    expect(item.attributes.get("data-synch-sync-percent")).toBe("100");
  });

  it("opens Synch settings when clicked", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("attention_needed", 0),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();
    rootEl.children[0].click();

    expect(plugin.openedSettings).toEqual(["open", "synch"]);
  });

  it("refreshes classes, attributes, and icon", () => {
    let syncState: SynchSyncState = "up_to_date";
    let storageStatus: SynchStorageStatus | null = null;
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      {
        getSyncState: () => syncState,
        getSyncPercent: () => 37,
        getStorageStatus: () => storageStatus,
      },
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();
    syncState = "attention_needed";
    storageStatus = {
      storageUsedBytes: 95,
      storageLimitBytes: 100,
    };
    indicator.refresh();

    const item = rootEl.children[0];
    expect(item.classes.has("synch-mobile-status-indicator-hidden")).toBe(false);
    expect(item.classes).toContain("synch-status-storage-warning");
    expect(item.attributes.get("data-synch-sync-state")).toBe("attention_needed");
    expect(item.attributes.get("data-synch-sync-percent")).toBe("37");
    expect(item.attributes.get("data-synch-storage-warning")).toBe("true");
    expect(item.children[0].attributes.get("data-icon")).toBe("triangle-alert");
  });

  it("removes the indicator on plugin cleanup", () => {
    const plugin = createPlugin();
    const rootEl = new FakeElement();
    const indicator = new SynchMobileStatusIndicator(
      plugin,
      createState("attention_needed", 0),
      rootEl as unknown as HTMLElement,
    );

    indicator.initialize();
    plugin.cleanupCallbacks[0]();

    expect(rootEl.children[0].removed).toBe(true);
  });
});
