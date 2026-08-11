import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import {
  decorateFileExplorerElement,
  SynchFileSizeBlockedDecorator,
  formatFileSizeBlockedTooltip,
} from "./file-size-blocked-decorator";

describe("Synch file-size blocked decorator", () => {
  it("adds an icon and tooltip to matching file explorer rows", () => {
    const root = createFileExplorerRoot(["large.md", "normal.md"]);

    decorateFileExplorerElement(
      root.asElement(),
      new Map([
        [
          "large.md",
          {
            path: "large.md",
            encryptedSizeBytes: 12_400_000,
            maxFileSizeBytes: 10_000_000,
          },
        ],
      ]),
    );

    const large = root.findByPath("large.md");
    const normal = root.findByPath("normal.md");
    expect(large?.classList.contains("synch-file-size-blocked")).toBe(true);
    expect(normal?.classList.contains("synch-file-size-blocked")).toBe(false);
    const icon = large?.children[0];
    expect(icon?.classList.contains("synch-file-size-blocked-icon")).toBe(true);
    expect(icon?.attributes.get("data-icon")).toBe("triangle-alert");
    expect(icon?.attributes.get("data-tooltip")).toBe(
      "Synch cannot sync this file because its encrypted size exceeds the file size limit. Encrypted: 12.4 MB. Limit: 10 MB.",
    );
  });

  it("does not duplicate icons on repeated refresh", () => {
    const root = createFileExplorerRoot(["large.md"]);
    const blocked = new Map([
      [
        "large.md",
        {
          path: "large.md",
          encryptedSizeBytes: 12_400_000,
          maxFileSizeBytes: 10_000_000,
        },
      ],
    ]);

    decorateFileExplorerElement(root.asElement(), blocked);
    decorateFileExplorerElement(root.asElement(), blocked);

    expect(root.findByPath("large.md")?.children).toHaveLength(1);
  });

  it("removes icons and classes when a file is no longer blocked", () => {
    const root = createFileExplorerRoot(["large.md"]);
    decorateFileExplorerElement(
      root.asElement(),
      new Map([
        [
          "large.md",
          {
            path: "large.md",
            encryptedSizeBytes: 12_400_000,
            maxFileSizeBytes: 10_000_000,
          },
        ],
      ]),
    );

    decorateFileExplorerElement(root.asElement(), new Map());

    const large = root.findByPath("large.md");
    expect(large?.classList.contains("synch-file-size-blocked")).toBe(false);
    expect(large?.children).toHaveLength(0);
  });

  it("removes icons and classes when the plugin unloads", async () => {
    const root = createFileExplorerRoot(["large.md"]);
    const cleanupCallbacks: Array<() => void> = [];
    const decorator = new SynchFileSizeBlockedDecorator(
      {
        app: {
          workspace: {
            on: () => ({}),
            getLeavesOfType: () => [
              {
                view: {
                  containerEl: root.asElement(),
                },
              },
            ],
          },
        },
        register: (callback: () => void) => {
          cleanupCallbacks.push(callback);
        },
        registerEvent: () => {},
      } as unknown as Plugin,
      {
        async listFileSizeBlockedFiles() {
          return [
            {
              path: "large.md",
              encryptedSizeBytes: 12_400_000,
              maxFileSizeBytes: 10_000_000,
            },
          ];
        },
      },
    );
    decorator.initialize();
    await decorator.refresh();

    cleanupCallbacks.forEach((callback) => callback());

    const large = root.findByPath("large.md");
    expect(large?.classList.contains("synch-file-size-blocked")).toBe(false);
    expect(large?.children).toHaveLength(0);
  });

  it("formats unknown blocked sizes without throwing", () => {
    expect(
      formatFileSizeBlockedTooltip({
        path: "large.md",
        encryptedSizeBytes: null,
        maxFileSizeBytes: null,
      }),
    ).toContain("Encrypted: unknown. Limit: unknown.");
  });
});

function createFileExplorerRoot(paths: string[]): FakeElement {
  const root = new FakeElement("div");
  for (const path of paths) {
    const title = new FakeElement("div");
    title.classList.add("nav-file-title");
    title.setAttribute("data-path", path);
    root.appendChild(title);
  }

  return root;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  private parent: FakeElement | null = null;

  constructor(readonly tagName: string) {}

  asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }

  appendChild(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  createSpan(options?: { cls?: string; attr?: Record<string, string> }): HTMLElement {
    const span = new FakeElement("span");
    if (options?.cls) {
      span.classList.add(options.cls);
    }
    for (const [name, value] of Object.entries(options?.attr ?? {})) {
      span.setAttribute(name, value);
    }
    this.appendChild(span);
    return span.asElement();
  }

  findByPath(path: string): FakeElement | null {
    return this.walk().find((element) => element.attributes.get("data-path") === path) ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.walk().filter((element) => element.matches(selector));
  }

  remove(): void {
    if (!this.parent) {
      return;
    }

    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  private matches(selector: string): boolean {
    if (selector === ".synch-file-size-blocked-icon") {
      return this.classList.contains("synch-file-size-blocked-icon");
    }
    if (selector === ".synch-file-size-blocked") {
      return this.classList.contains("synch-file-size-blocked");
    }
    if (selector === ".nav-file-title[data-path]") {
      return this.classList.contains("nav-file-title") && this.attributes.has("data-path");
    }

    return false;
  }

  private walk(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.walk())];
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}
