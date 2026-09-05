export const PUSH_BATCH_SIZE = 100;
const COMMIT_COALESCE_MS = 100;

/** Own entries until the consumer finishes committing and applying the batch. */
export async function* preparePushBatches<T extends { entryId: string }, U>(
  load: (limit: number, excluded: ReadonlySet<string>) => Promise<T[]>,
  concurrency: number,
  prepare: (item: T) => Promise<U>,
  shouldYield: () => boolean,
): AsyncGenerator<U[]> {
  const owned = new Set<string>();
  const waiting: Array<{ item: T; index: number }> = [];
  const ready: Array<{ item: T; index: number; value: U }> = [];
  const jobs = new Set<Promise<void>>();
  const normalized = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(PUSH_BATCH_SIZE, Math.max(1, normalized));
  let nextIndex = 0;
  let stopped = false;
  let yielding = false;
  let sourceEmpty = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushReady = false;

  function throwIfFailed(): void {
    if (failure) throw failure.error;
  }

  function updateAndCheckSupplyStop(): boolean {
    // Once requested, yielding remains active for the rest of this drain.
    yielding ||= shouldYield();
    return stopped || yielding;
  }

  function pump(): void {
    while (!updateAndCheckSupplyStop() && jobs.size < workerCount && waiting.length > 0) {
      const work = waiting.shift()!;
      const job = Promise.resolve().then(() => prepare(work.item)).then(
        (value) => {
          ready.push({ ...work, value });
          if (timer === undefined && !stopped) {
            timer = setTimeout(() => {
              flushReady = true;
              wake?.();
            }, COMMIT_COALESCE_MS);
          }
        },
        (error: unknown) => {
          failure ??= { error };
          stopped = true;
        },
      ).finally(() => {
        jobs.delete(job);
        pump();
        wake?.();
      });
      jobs.add(job);
    }
  }

  try {
    while (true) {
      throwIfFailed();
      if (!updateAndCheckSupplyStop() && !sourceEmpty && owned.size < PUSH_BATCH_SIZE) {
        const items = await load(PUSH_BATCH_SIZE - owned.size, owned);
        // A pull can arrive during the store read. Do not start its results.
        if (!updateAndCheckSupplyStop()) {
          sourceEmpty = items.length === 0;
          for (const item of items) {
            owned.add(item.entryId);
            waiting.push({ item, index: nextIndex++ });
          }
          pump();
        }
      }
      throwIfFailed();
      const preparationFinished = jobs.size === 0 && (yielding || waiting.length === 0);
      if (ready.length > 0 &&
          (flushReady || ready.length >= PUSH_BATCH_SIZE || preparationFinished)) {
        clearTimeout(timer);
        timer = undefined;
        flushReady = false;
        ready.sort((left, right) => left.index - right.index);
        const batch = ready.splice(0, PUSH_BATCH_SIZE);
        yield batch.map(({ value }) => value);
        for (const { item } of batch) owned.delete(item.entryId);
        sourceEmpty = false;
        continue;
      }
      if (preparationFinished && (yielding || sourceEmpty)) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    stopped = true;
    clearTimeout(timer);
    // No cancellation is available on the blob client. Join started operations
    // before the caller disposes crypto or allows pull to mutate the store.
    await Promise.all(jobs);
  }
}
