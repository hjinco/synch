import type { ContentReservation, SyncContentRuntime } from "../core/content-runtime";

/** Prepare bounded groups in parallel; consume them in plan order. Reservations
 * include ready results and survive until apply has dropped every payload.
 * Reserve in plan order too: a later oversized group must not hold the budget
 * while the consumer waits for an earlier group to be admitted.
 */
export async function runPullPreparationPipeline<T>(options: {
  groups: T[];
  concurrency: number;
  runtime: SyncContentRuntime;
  estimatedBytes: (group: T) => number;
  prepare: (group: T, reservation: ContentReservation) => Promise<void>;
  apply: (group: T) => Promise<void>;
  clear: (group: T) => void;
}): Promise<void> {
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency)) : 1;
  let stopped = false;
  let failure: unknown;
  let next = 0;
  type Prepared = { group: T; reservation: ContentReservation };
  const pending: Array<Promise<Prepared | null>> = [];
  const clear = ({ group, reservation }: Prepared) => {
    options.clear(group);
    reservation.release();
  };
  const start = (group: T): Promise<Prepared | null> => (async () => {
    const reservation = await options.runtime.reserve(options.estimatedBytes(group));
    const prepared = { group, reservation };
    try {
      if (stopped) {
        clear(prepared);
        return null;
      }
      await options.prepare(group, reservation);
      return prepared;
    } catch (error) {
      clear(prepared);
      throw error;
    }
  })().catch((error: unknown) => {
    if (!stopped) failure = error;
    stopped = true;
    return null;
  });

  try {
    while (next < options.groups.length || pending.length > 0) {
      while (!stopped && next < options.groups.length && pending.length < concurrency) {
        pending.push(start(options.groups[next++]!));
      }
      const prepared = await pending.shift();
      if (!prepared) throw failure;
      try {
        if (stopped) throw failure;
        await options.apply(prepared.group);
      } finally {
        clear(prepared);
      }
    }
  } finally {
    stopped = true;
    // Release each completed result as it settles, allowing queued reservations
    // to drain even when an earlier preparation or vault write failed.
    await Promise.all(pending.map(async (task) => {
      const prepared = await task;
      if (prepared) clear(prepared);
    }));
  }
}
