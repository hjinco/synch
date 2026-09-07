import type { PlannedEntryState, PullEntryStateManifestItem } from "./pull-entry-state-internal";

export interface PullApplicationGroup {
  plans: PlannedEntryState[];
  superseded: PullEntryStateManifestItem[];
}

/** Include store ownership as well as vault paths: adoption, supersession and
 * pending-mutation handling must never cross independently applied groups.
 */
export function groupPullApplications(
  plans: PlannedEntryState[],
  superseded: Array<{ item: PullEntryStateManifestItem; existingPath: string | null }>,
): PullApplicationGroup[] {
  const nodes = [
    ...plans.map((plan) => ({
      plan,
      item: null as PullEntryStateManifestItem | null,
      keys: [
        ...[plan.state.entryId, plan.adoptedLocalEntry?.entry.entryId,
          plan.supersededPathOwner?.entryId].filter(Boolean).map((id) => `entry:${id}`),
        ...[plan.finalPath, plan.existing?.path, plan.metadata.path,
          plan.vaultMove?.from, plan.vaultMove?.to, plan.adoptedLocalEntry?.entry.path,
          plan.supersededPathOwner?.path].filter(Boolean).map((path) => `path:${path}`),
      ],
    })),
    ...superseded.map(({ item, existingPath }) => ({
      plan: null as PlannedEntryState | null,
      item,
      keys: [`entry:${item.state.entryId}`,
        ...[item.metadata.path, existingPath].filter(Boolean).map((path) => `path:${path}`)],
    })),
  ];
  const parent = nodes.map((_, index) => index);
  const root = (index: number): number => {
    if (parent[index] !== index) parent[index] = root(parent[index]!);
    return parent[index]!;
  };
  const owners = new Map<string, number>();
  nodes.forEach((node, index) => {
    for (const key of node.keys) {
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
      group = { plans: [], superseded: [] };
      groups.set(id, group);
    }
    if (node.plan) group.plans.push(node.plan);
    if (node.item) group.superseded.push(node.item);
  });
  return [...groups.values()];
}
