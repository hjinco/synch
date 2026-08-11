export type TextMergeResult =
  | {
      status: "clean";
      text: string;
    }
  | {
      status: "conflict";
    };

type Replacement = {
  start: number;
  end: number;
  lines: string[];
};

const MAX_LCS_CELLS = 2_000_000;

export function mergeText3(base: string, local: string, remote: string): TextMergeResult {
  if (local === remote) {
    return { status: "clean", text: local };
  }
  if (base === local) {
    return { status: "clean", text: remote };
  }
  if (base === remote) {
    return { status: "clean", text: local };
  }

  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  if (
    exceedsLcsBudget(baseLines, localLines) ||
    exceedsLcsBudget(baseLines, remoteLines)
  ) {
    return { status: "conflict" };
  }

  const localChanges = diffReplacements(baseLines, localLines);
  const remoteChanges = diffReplacements(baseLines, remoteLines);
  const merged = mergeReplacements(baseLines, localChanges, remoteChanges);
  return merged ? { status: "clean", text: merged.join("") } : { status: "conflict" };
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }

  const lines = text.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function exceedsLcsBudget(left: string[], right: string[]): boolean {
  return (left.length + 1) * (right.length + 1) > MAX_LCS_CELLS;
}

function diffReplacements(base: string[], variant: string[]): Replacement[] {
  const lcs = createLcsTable(base, variant);
  const replacements: Replacement[] = [];
  let current: Replacement | null = null;
  let baseIndex = 0;
  let variantIndex = 0;

  const ensureCurrent = () => {
    current ??= { start: baseIndex, end: baseIndex, lines: [] };
    return current;
  };
  const flush = () => {
    if (!current) {
      return;
    }
    replacements.push(current);
    current = null;
  };

  while (baseIndex < base.length && variantIndex < variant.length) {
    if (base[baseIndex] === variant[variantIndex]) {
      flush();
      baseIndex += 1;
      variantIndex += 1;
      continue;
    }

    if (lcs[baseIndex + 1][variantIndex] >= lcs[baseIndex][variantIndex + 1]) {
      const replacement = ensureCurrent();
      baseIndex += 1;
      replacement.end = baseIndex;
    } else {
      ensureCurrent().lines.push(variant[variantIndex]);
      variantIndex += 1;
    }
  }

  while (baseIndex < base.length) {
    const replacement = ensureCurrent();
    baseIndex += 1;
    replacement.end = baseIndex;
  }
  while (variantIndex < variant.length) {
    ensureCurrent().lines.push(variant[variantIndex]);
    variantIndex += 1;
  }
  flush();

  return replacements;
}

function createLcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? table[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }

  return table;
}

function mergeReplacements(
  base: string[],
  localChanges: Replacement[],
  remoteChanges: Replacement[],
): string[] | null {
  const output: string[] = [];
  let baseIndex = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  const copyUnchanged = (targetIndex: number) => {
    while (baseIndex < targetIndex) {
      output.push(base[baseIndex]);
      baseIndex += 1;
    }
  };
  const applyReplacement = (replacement: Replacement) => {
    copyUnchanged(replacement.start);
    output.push(...replacement.lines);
    baseIndex = replacement.end;
  };

  while (localIndex < localChanges.length || remoteIndex < remoteChanges.length) {
    const local = localChanges[localIndex] ?? null;
    const remote = remoteChanges[remoteIndex] ?? null;

    if (local && remote && sameRange(local, remote)) {
      if (!sameLines(local.lines, remote.lines)) {
        return null;
      }
      applyReplacement(local);
      localIndex += 1;
      remoteIndex += 1;
      continue;
    }

    if (local && remote && conflictsAtSameInsertionPoint(local, remote)) {
      return null;
    }

    if (local && remote && rangesOverlap(local, remote)) {
      return null;
    }

    if (local && (!remote || local.end <= remote.start)) {
      applyReplacement(local);
      localIndex += 1;
      continue;
    }

    if (remote && (!local || remote.end <= local.start)) {
      applyReplacement(remote);
      remoteIndex += 1;
      continue;
    }

    return null;
  }

  copyUnchanged(base.length);
  return output;
}

function sameRange(left: Replacement, right: Replacement): boolean {
  return left.start === right.start && left.end === right.end;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function rangesOverlap(left: Replacement, right: Replacement): boolean {
  return left.start < right.end && right.start < left.end;
}

function conflictsAtSameInsertionPoint(left: Replacement, right: Replacement): boolean {
  return (
    left.start === left.end &&
    right.start === right.end &&
    left.start === right.start &&
    !sameLines(left.lines, right.lines)
  );
}
