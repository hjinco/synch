import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import {
  getStatusBarIcon,
  getStatusBarStateClass,
  SynchStatusBar,
  type SynchStatusBarState,
} from "./status-bar";
import type { SynchStorageStatus, SynchSyncState } from "../contracts";

class FakeStatusBarElement {
  text = "";
  attributes = new Map<string, string>();
  classes = new Set<string>();
  children: FakeStatusBarElement[] = [];
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

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setText(value: string): void {
    this.text = value;
  }

  empty(): void {
    this.text = "";
    this.children = [];
  }

  createEl(_tag: string, options?: { cls?: string }): FakeStatusBarElement {
    const element = new FakeStatusBarElement();
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
}

function createPlugin(): Plugin & {
  addedStatusBarItems: FakeStatusBarElement[];
  openedSettings: string[];
} {
  const addedStatusBarItems: FakeStatusBarElement[] = [];
  const openedSettings: string[] = [];

  return {
    addedStatusBarItems,
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
    addStatusBarItem: () => {
      const item = new FakeStatusBarElement();
      addedStatusBarItems.push(item);
      return item as unknown as HTMLElement;
    },
    registerDomEvent: (
      element: FakeStatusBarElement,
      type: string,
      callback: () => void,
    ) => {
      element.addEventListener(type, callback);
    },
  } as unknown as Plugin & {
    addedStatusBarItems: FakeStatusBarElement[];
    openedSettings: string[];
  };
}

function createState(
  syncState: SynchSyncState,
  percent = 37,
  storageStatus: SynchStorageStatus | null = null,
): SynchStatusBarState {
  return {
    getSyncState: () => syncState,
    getSyncPercent: () => percent,
    getStorageStatus: () => storageStatus,
  };
}

function expectElementState(
  item: FakeStatusBarElement,
  syncState: SynchSyncState,
  percent: number,
): void {
  expect(item.classes).toContain("synch-status-bar");
  expect(item.classes).toContain(getStatusBarStateClass(syncState));
  expect(item.attributes.has("title")).toBe(false);
  expect(item.attributes.get("aria-label")).toBe("Open Synch settings");
  expect(item.attributes.get("data-synch-sync-state")).toBe(syncState);
  expect(item.attributes.get("data-synch-sync-percent")).toBe(String(percent));
  expect(item.attributes.get("data-synch-storage-warning")).toBe("false");
  expect(item.children[0].attributes.get("data-icon")).toBe(getStatusBarIcon(syncState));
}

describe("SynchStatusBar", () => {
  it("creates a custom Synch status bar item", () => {
    const plugin = createPlugin();
    const statusBar = new SynchStatusBar(plugin, createState("syncing", 37));

    statusBar.initialize();

    expect(plugin.addedStatusBarItems).toHaveLength(1);
    const item = plugin.addedStatusBarItems[0];
    expect(item.text).toBe("");
    expect(item.attributes.get("role")).toBe("button");
    expect(item.children).toHaveLength(1);
    expect(item.children[0].classes).toContain("synch-status-bar-icon");
    expect(item.children[0].attributes.get("aria-hidden")).toBe("true");
    expectElementState(item, "syncing", 37);
    expect(item.classes).toContain("synch-status-active");
  });

  it("does not require the native Obsidian sync status bar item", () => {
    const plugin = createPlugin();
    const statusBar = new SynchStatusBar(plugin, createState("offline", 0));

    statusBar.initialize();

    expect(plugin.addedStatusBarItems).toHaveLength(1);
    expectElementState(plugin.addedStatusBarItems[0], "offline", 0);
  });

  it("opens the Synch settings tab when clicked", () => {
    const plugin = createPlugin();
    const statusBar = new SynchStatusBar(plugin, createState("up_to_date", 100));

    statusBar.initialize();
    plugin.addedStatusBarItems[0].click();

    expect(plugin.openedSettings).toEqual(["open", "synch"]);
  });

  it.each([
    ["not_ready", 0, false],
    ["paused", 0, false],
    ["pending", 100, false],
    ["syncing", 37, true],
    ["offline", 0, false],
    ["reconnecting", 0, true],
    ["up_to_date", 100, false],
    ["attention_needed", 0, false],
  ] satisfies Array<[SynchSyncState, number, boolean]>)(
    "maps %s to status bar attributes and classes",
    (syncState, percent, active) => {
      const plugin = createPlugin();

      const statusBar = new SynchStatusBar(plugin, createState(syncState, percent));

      statusBar.initialize();

      const item = plugin.addedStatusBarItems[0];
      expectElementState(item, syncState, percent);
      expect(item.classes.has("synch-status-active")).toBe(active);
    },
  );

  it("shows a storage warning without changing the sync state", () => {
    const plugin = createPlugin();
    const statusBar = new SynchStatusBar(
      plugin,
      createState("up_to_date", 100, {
        storageUsedBytes: 95,
        storageLimitBytes: 100,
      }),
    );

    statusBar.initialize();

    const item = plugin.addedStatusBarItems[0];
    expect(item.classes).toContain("synch-status-up-to-date");
    expect(item.classes).toContain("synch-status-storage-warning");
    expect(item.classes.has("synch-status-active")).toBe(false);
    expect(item.attributes.get("aria-label")).toBe(
      "Synch storage is almost full. Open Synch settings",
    );
    expect(item.attributes.get("data-synch-sync-state")).toBe("up_to_date");
    expect(item.attributes.get("data-synch-storage-warning")).toBe("true");
    expect(item.children[0].attributes.get("data-icon")).toBe("triangle-alert");
  });

  it("shows plugin update required as an alert state", () => {
    const plugin = createPlugin();
    const statusBar = new SynchStatusBar(plugin, createState("update_required", 0));

    statusBar.initialize();

    const item = plugin.addedStatusBarItems[0];
    expect(item.classes).toContain("synch-status-update-required");
    expect(item.classes.has("synch-status-active")).toBe(false);
    expect(item.attributes.get("aria-label")).toBe(
      "Synch plugin update required. Open Synch settings",
    );
    expect(item.attributes.get("data-synch-sync-state")).toBe("update_required");
    expect(item.children[0].attributes.get("data-icon")).toBe("triangle-alert");
  });
});
