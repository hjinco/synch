export const PUSH_BATCH_SIZE = 100;
// Coalesce completions during slower uploads; flush immediately once the
// selection is fully prepared so fast local transports pay no timer delay.
const COMMIT_COALESCE_MS = 100;

/**
 * Prepare one bounded selection of dirty entries while the consumer commits
 * completed batches. The caller must finish this selection before reading the
 * next one, so a newer mutation for the same entry cannot overtake its commit.
 */
export async function* preparePushBatches<T, U>(
  items: T[],
  concurrency: number,
  prepare: (item: T) => Promise<U>,
): AsyncGenerator<U[]> {
  const ready: Array<{ index: number; value: U }> = [];
  const normalized = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.max(0, Math.min(Math.max(1, normalized), items.length));
  let nextIndex = 0;
  let activeWorkers = workerCount;
  let stopped = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushReady = false;

  const workers = Promise.all(Array.from({ length: workerCount }, async () => {
    try {
      while (!stopped && nextIndex < items.length) {
        const index = nextIndex++;
        const value = await prepare(items[index]!);
        if (stopped) break;
        ready.push({ index, value });
        if (timer === undefined) {
          timer = setTimeout(() => {
            flushReady = true;
            wake?.();
          }, COMMIT_COALESCE_MS);
        }
        wake?.();
      }
    } catch (error) {
      failure ??= { error };
      stopped = true;
    } finally {
      activeWorkers -= 1;
      wake?.();
    }
  }));

  try {
    while (true) {
      if (failure) throw failure.error;
      if (ready.length > 0 &&
          (flushReady || ready.length >= PUSH_BATCH_SIZE || activeWorkers === 0)) {
        clearTimeout(timer);
        timer = undefined;
        flushReady = false;
        // Preserve queue order among ready entries without waiting for slow ones.
        ready.sort((left, right) => left.index - right.index);
        yield ready.splice(0, PUSH_BATCH_SIZE).map(({ value }) => value);
        continue;
      }
      if (activeWorkers === 0) break;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } finally {
    stopped = true;
    clearTimeout(timer);
    // Uploads cannot be cancelled through the blob client. Join them before the
    // caller flushes the store or disposes the shared crypto context, including
    // when a commit fails or the consumer stops on a rejected mutation.
    await workers;
  }
}
