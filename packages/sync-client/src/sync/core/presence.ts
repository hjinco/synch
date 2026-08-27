export type PresencePosition = {
  line: number;
  ch: number;
};

export type PresenceSelection = {
  anchor: PresencePosition;
  head: PresencePosition;
};

export function isPresenceSelection(value: unknown): value is PresenceSelection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isPresencePosition(record.anchor) && isPresencePosition(record.head);
}

function isPresencePosition(value: unknown): value is PresencePosition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.line === "number" &&
    Number.isInteger(record.line) &&
    record.line >= 0 &&
    typeof record.ch === "number" &&
    Number.isInteger(record.ch) &&
    record.ch >= 0
  );
}
