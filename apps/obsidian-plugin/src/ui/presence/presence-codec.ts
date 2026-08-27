import type { PresenceSelection } from "@synch/sync-client/sync/core/presence";

export type PresencePeer = {
  presenceId: string;
  entryId: string;
  userId: string;
  displayName: string;
  path: string | null;
  selection: PresenceSelection;
};

export function presencePeerFromSelection(
  identity: {
    presenceId: string;
    entryId: string;
    userId: string;
    displayName: string;
  },
  selection: PresenceSelection,
  path: string | null,
): PresencePeer {
  return {
    presenceId: identity.presenceId,
    entryId: identity.entryId,
    userId: identity.userId,
    displayName: identity.displayName,
    path,
    selection,
  };
}

export function peersOnPath(
  roster: Iterable<PresencePeer>,
  path: string,
): PresencePeer[] {
  const matched: PresencePeer[] = [];
  for (const peer of roster) {
    if (peer.path === path) {
      matched.push(peer);
    }
  }
  return matched;
}

export function presencePeerLabel(
  peer: Pick<PresencePeer, "displayName">,
): string {
  const name = peer.displayName.trim();
  return name || "Anonymous";
}

export function colorForPresenceId(presenceId: string): string {
  return presenceColor(presenceId);
}

export function selectionColorForPresenceId(presenceId: string): string {
  return presenceColor(presenceId, 0.2);
}

function presenceColor(presenceId: string, alpha?: number): string {
  let hash = 0;
  for (let index = 0; index < presenceId.length; index += 1) {
    hash = (hash * 31 + presenceId.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return alpha === undefined
    ? `hsl(${hue} 70% 45%)`
    : `hsl(${hue} 70% 45% / ${alpha})`;
}
