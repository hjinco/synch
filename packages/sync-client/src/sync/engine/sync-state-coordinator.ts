import type { SyncEntryStore } from "../store/ports";

export interface SyncStateResources {
  entryIds?: ReadonlyArray<string | null | undefined>;
  paths?: ReadonlyArray<string | null | undefined>;
}

export function syncStateKeys(resources: SyncStateResources): string[] {
  return [...new Set([
    ...(resources.entryIds ?? []).filter(Boolean).map((id) => `entry:${id}`),
    ...(resources.paths ?? []).filter(Boolean).map((path) => `path:${path}`),
  ])];
}

/** A stale local plan must be rebuilt, never repaired by only bumping revision. */
export class SyncStateChangedError extends Error {
  readonly code = "local_sync_state_changed";

  constructor() {
    super("Local sync state changed while preparing work; retry with a fresh snapshot.");
    this.name = "SyncStateChangedError";
  }
}

export interface SyncStateSnapshot {
  assertCurrent(keys: readonly string[]): void;
  dispose(): void;
}

/**
 * One coordinator per store, shared by standalone services as well as the engine.
 * Multi-key acquisition is queued atomically, so rename/path-owner dependencies
 * cannot deadlock. Network and byte-budget admission must happen outside run().
 * Snapshots invalidate only related work and retain no historical key versions.
 */
export class SyncStateCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();
  private readonly snapshots = new Set<Set<string>>();

  watch(): SyncStateSnapshot {
    const changed = new Set(this.active);
    this.snapshots.add(changed);
    return {
      assertCurrent: (keys) => {
        if (keys.some((key) => changed.has(key))) throw new SyncStateChangedError();
      },
      dispose: () => { this.snapshots.delete(changed); },
    };
  }

  async run<T>(
    keys: readonly string[],
    work: () => Promise<T>,
    snapshots: readonly SyncStateSnapshot[] = [],
  ): Promise<T> {
    const unique = [...new Set(keys)];
    const predecessors = unique.flatMap((key) => this.tails.get(key) ?? []);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    for (const key of unique) this.tails.set(key, tail);
    let started = false;
    try {
      await Promise.all(predecessors);
      for (const snapshot of snapshots) snapshot.assertCurrent(unique);
      for (const key of unique) this.active.add(key);
      this.invalidate(unique);
      started = true;
      return await work();
    } finally {
      if (started) {
        this.invalidate(unique);
        for (const key of unique) this.active.delete(key);
      }
      for (const key of unique) {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
      release();
    }
  }

  private invalidate(keys: readonly string[]): void {
    for (const changed of this.snapshots) {
      for (const key of keys) changed.add(key);
    }
  }
}

const coordinators = new WeakMap<object, SyncStateCoordinator>();

export function syncStateCoordinator(store: object): SyncStateCoordinator {
  let coordinator = coordinators.get(store);
  if (!coordinator) {
    coordinator = new SyncStateCoordinator();
    coordinators.set(store, coordinator);
  }
  return coordinator;
}

export async function retrySyncStateWork<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      // Continuous edits must yield to the caller's normal retry/backoff policy.
      if (!(error instanceof SyncStateChangedError) || attempt >= 2) throw error;
    }
  }
}

type ResourceStore = Pick<SyncEntryStore, "getEntryById" | "getEntryByPath">;

/** Resolve current owners/paths again if they moved while acquiring the keys. */
export async function withSyncState<T>(
  store: ResourceStore,
  resources: SyncStateResources,
  work: () => Promise<T>,
  prepared?: SyncStateSnapshot,
): Promise<T> {
  const coordinator = syncStateCoordinator(store);
  for (let attempt = 0; ; attempt += 1) {
    const resolution = coordinator.watch();
    let entered = false;
    let keys: string[] = [];
    try {
      const entryIds = new Set(resources.entryIds?.filter((id): id is string => !!id));
      const paths = new Set(resources.paths?.filter((path): path is string => !!path));
      for (const path of paths) {
        const owner = await store.getEntryByPath(path);
        if (owner) entryIds.add(owner.entryId);
      }
      for (const id of entryIds) {
        const entry = await store.getEntryById(id);
        if (entry?.path) paths.add(entry.path);
      }
      keys = syncStateKeys({ entryIds: [...entryIds], paths: [...paths] });
      return await coordinator.run(keys, async () => {
        entered = true;
        return await work();
      }, prepared ? [resolution, prepared] : [resolution]);
    } catch (error) {
      // Only retry resource discovery. A caller's apply may already have made
      // partial progress, and stale preparation must be rebuilt by its owner.
      if (entered || !(error instanceof SyncStateChangedError) || attempt >= 2) throw error;
      prepared?.assertCurrent(keys);
    } finally {
      resolution.dispose();
    }
  }
}
