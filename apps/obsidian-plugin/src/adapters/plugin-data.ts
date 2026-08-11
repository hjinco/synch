import type { Plugin } from "obsidian";

export type PluginDataRecord = Record<string, unknown>;

export interface PluginDataStoreLike {
  initialize(): Promise<void>;
  read<T = unknown>(key: string): T | undefined;
  write(key: string, value: unknown): void;
  save(): Promise<void>;
}

export class SynchPluginDataStore implements PluginDataStoreLike {
  private initialized = false;
  private data: PluginDataRecord = {};

  constructor(private readonly plugin: Plugin) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.data = normalizePluginData(await this.plugin.loadData());
    this.initialized = true;
  }

  read<T = unknown>(key: string): T | undefined {
    this.requireInitialized();
    return this.data[key] as T | undefined;
  }

  write(key: string, value: unknown): void {
    this.requireInitialized();
    if (value === undefined) {
      delete this.data[key];
      return;
    }

    this.data[key] = value;
  }

  async save(): Promise<void> {
    this.requireInitialized();
    await this.plugin.saveData(this.data);
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("plugin data store is not initialized");
    }
  }
}

function normalizePluginData(value: unknown): PluginDataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as PluginDataRecord) };
}
