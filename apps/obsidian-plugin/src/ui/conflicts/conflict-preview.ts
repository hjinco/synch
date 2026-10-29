/** The bytes shown in a comparison, including binary and missing-original cases. */
export interface ConflictFileSnapshot {
  path: string;
  bytes: Uint8Array;
}

export interface ConflictPreview {
  originalFile: ConflictFileSnapshot | null;
  copyFile: ConflictFileSnapshot;
  original: string | null;
  copy: string | null;
  merged: string | null;
}

export function decodeConflictText(bytes: Uint8Array): string | null {
  try {
    // Preserve a BOM so a text write can reproduce the original bytes exactly.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

export function sameConflictBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
