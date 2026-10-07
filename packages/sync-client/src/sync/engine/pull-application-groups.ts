import { syncStateKeys, type SyncStateResources } from "./sync-state-coordinator";
import type { PlannedEntryState, PullEntryStateManifestItem } from "./pull-entry-state-internal";

export interface PullApplicationGroup {
  plans: PlannedEntryState[];
  superseded: PullEntryStateManifestItem[];
  skipped: PullEntryStateManifestItem[];
  resources: {
    entryIds: Array<string | null | undefined>;
    paths: Array<string | null | undefined>;
  };
}

/** Include store ownership as well as vault paths: adoption, supersession and
 * skipped remote updates must never invalidate another group's preparation.
 */
export function groupPullApplications(
  plans: PlannedEntryState[],
  superseded: Array<{ item: PullEntryStateManifestItem; existingPath: string | null }>,
  skipped: Array<{ item: PullEntryStateManifestItem; existingPath: string | null }>,
): PullApplicationGroup[] {
  const nodes = [
    ...plans.map((plan) => ({
      kind: "plan" as const,
      item: plan,
      resources: pullPlanResources(plan),
    })),
    ...superseded.map(({ item, existingPath }) => ({
      kind: "superseded" as const,
      item,
      resources: { entryIds: [item.state.entryId], paths: [item.metadata.path, existingPath] },
    })),
    ...skipped.map(({ item, existingPath }) => ({
      kind: "skipped" as const,
      item,
      resources: { entryIds: [item.state.entryId], paths: [item.metadata.path, existingPath] },
    })),
  ];
  const parent = nodes.map((_, index) => index);
  const root = (index: number): number => {
    if (parent[index] !== index) parent[index] = root(parent[index]);
    return parent[index];
  };
  const owners = new Map<string, number>();
  nodes.forEach((node, index) => {
    for (const key of syncStateKeys(node.resources)) {
      const owner = owners.get(key);
      if (owner !== undefined) parent[root(index)] = root(owner);
      else owners.set(key, index);
    }
  });
  const groups = new Map<number, PullApplicationGroup>();
  nodes.forEach((node, index) => {
    const id = root(index);
    let group = groups.get(id);
    if (!group) {
      group = { plans: [], superseded: [], skipped: [], resources: { entryIds: [], paths: [] } };
      groups.set(id, group);
    }
    if (node.kind === "plan") group.plans.push(node.item);
    else group[node.kind].push(node.item);
    group.resources.entryIds.push(...node.resources.entryIds ?? []);
    group.resources.paths.push(...node.resources.paths ?? []);
  });
  return [...groups.values()];
}

/** State dependencies include historical paths for ownership coordination.
 * Only pullPlanFilePaths describes files whose bytes the application uses. */
export function pullPlanResources(plan: PlannedEntryState): SyncStateResources {
  return {
    entryIds: [plan.state.entryId, plan.adoptedLocalEntry?.entry.entryId,
      plan.supersededPathOwner?.entryId],
    paths: [plan.finalPath, plan.existing?.path, plan.metadata.path,
      plan.vaultMove?.from, plan.vaultMove?.to, plan.adoptedLocalEntry?.entry.path,
      plan.supersededPathOwner?.path],
  };
}

export function pullPlanFilePaths(plan: PlannedEntryState): Array<string | null | undefined> {
  return [
    plan.finalPath,
    plan.existing?.deleted ? null : plan.existing?.path,
    plan.vaultMove?.from,
    plan.vaultMove?.to,
    plan.adoptedLocalEntry?.entry.path,
  ];
}
