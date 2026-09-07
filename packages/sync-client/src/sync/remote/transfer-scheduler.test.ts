import { describe, expect, it } from "vitest";
import { TransferScheduler, type TransferDirection, type TransferResult } from "./transfer-scheduler";

function harness() {
  let now = 0;
  const scheduler = new TransferScheduler(() => now);
  const started: number[] = [];
  const controls = new Map<number, {
    resolve: (result: TransferResult<number>) => void;
    reject: (error: unknown) => void;
  }>();
  function add(id: number, direction: TransferDirection = "upload") {
    return scheduler.run(direction, () => {
      started.push(id);
      return new Promise<TransferResult<number>>((resolve, reject) => {
        controls.set(id, { resolve, reject });
      });
    });
  }
  return { scheduler, started, controls, add, advance: (ms: number) => { now += ms; } };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// Model bounded preparation batches with a fixed network round-trip time.
async function transferBatch(h: ReturnType<typeof harness>, count = 12) {
  const firstId = h.started.length;
  const jobs = Array.from({ length: count }, (_, index) => h.add(firstId + index));
  await flush();
  let completed = firstId;
  let peak = 0;
  while (completed < firstId + count) {
    const active = h.started.slice(completed);
    peak = Math.max(peak, active.length);
    h.advance(100);
    for (const id of active) h.controls.get(id)!.resolve({ value: id, bytes: 100 });
    completed += active.length;
    await flush();
  }
  await Promise.all(jobs);
  return peak;
}

describe("TransferScheduler", () => {
  it.each([0, 4_000])("learns across short batches excluding %i ms gaps", async gap => {
    const h = harness();
    for (let batch = 0; batch < 12; batch += 1) {
      await transferBatch(h);
      // Introduce apply delays only after establishing the baseline, so counting
      // idle time would make the faster probe appear slower and roll it back.
      h.advance(batch < 3 ? 0 : gap);
    }
    // Both the baseline and probe require multiple batches. The extra slot
    // must survive the gaps and be retained after measuring its throughput.
    expect(await transferBatch(h)).toBeGreaterThanOrEqual(3);
    await h.scheduler.dispose();
  });

  it("discards partial observations after a long gap", async () => {
    const h = harness();
    for (let batch = 0; batch < 12; batch += 1) {
      expect(await transferBatch(h)).toBe(2);
      h.advance(10_000);
    }
    await h.scheduler.dispose();
  });

  it("rolls back an unfinished probe after a long gap", async () => {
    const h = harness();
    for (let batch = 0; batch < 4; batch += 1) await transferBatch(h);
    expect(await transferBatch(h)).toBe(3);
    h.advance(10_000);
    expect(await transferBatch(h)).toBe(2);
    await h.scheduler.dispose();
  });

  it("discards partial observations on application errors", async () => {
    const h = harness();
    for (let batch = 0; batch < 3; batch += 1) await transferBatch(h);
    const id = h.started.length;
    const job = h.add(id);
    await flush();
    h.controls.get(id)!.reject({ status: 403 });
    await expect(job).rejects.toEqual({ status: 403 });
    await flush();
    expect(await transferBatch(h)).toBe(2);
    expect(await transferBatch(h)).toBe(2);
    await h.scheduler.dispose();
  });

  it("bounds each direction independently and preserves FIFO admission", async () => {
    const h = harness();
    const jobs = [h.add(1), h.add(2), h.add(3), h.add(4, "download"), h.add(5, "download")];
    await flush();
    expect(h.started).toEqual([1, 2, 4, 5]);
    h.controls.get(2)!.resolve({ value: 2, bytes: 100 });
    await flush();
    expect(h.started).toEqual([1, 2, 4, 5, 3]);
    for (const id of [1, 3, 4, 5]) h.controls.get(id)!.resolve({ value: id, bytes: 100 });
    await expect(Promise.all(jobs)).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  it("reduces admission after overload without cancelling active requests or retrying", async () => {
    const h = harness();
    const jobs = [h.add(1), h.add(2), h.add(3)];
    const results = Promise.allSettled(jobs);
    await flush();
    const error = { status: 503 };
    h.controls.get(1)!.reject(error);
    await flush();
    expect(h.started).toEqual([1, 2]);
    h.controls.get(2)!.resolve({ value: 2, bytes: 100 });
    await flush();
    expect(h.started).toEqual([1, 2, 3]);
    h.controls.get(3)!.resolve({ value: 3, bytes: 100 });
    expect((await results)[0]).toEqual({ status: "rejected", reason: error });
  });

  it.each([{ status: 401 }, { status: 403 }, { status: 413 }, new SyntaxError("invalid JSON")])(
    "does not treat application failures as congestion: %s", async error => {
      const h = harness();
      const results = Promise.allSettled([h.add(1), h.add(2), h.add(3)]);
      await flush();
      h.controls.get(1)!.reject(error);
      await flush();
      expect(h.started).toEqual([1, 2, 3]);
      for (const id of [2, 3]) h.controls.get(id)!.resolve({ value: id, bytes: 100 });
      await results;
    },
  );

  it("probes under sustained demand using wall-clock aggregate throughput", async () => {
    const h = harness();
    const results = Promise.allSettled(Array.from({ length: 12 }, (_, id) => h.add(id)));
    await flush();
    for (let id = 0; id < 4; id += 1) {
      h.advance(500);
      h.controls.get(id)!.resolve({ value: id, bytes: 100 });
      await flush();
    }
    expect(h.started).toHaveLength(7); // Four finished, three now active.
    const closing = h.scheduler.dispose();
    for (const id of [4, 5, 6]) h.controls.get(id)!.resolve({ value: id, bytes: 100 });
    await closing;
    await results;
  });

  it("rejects queued work on disposal and waits for active transfers", async () => {
    const h = harness();
    const results = Promise.allSettled([h.add(1), h.add(2), h.add(3)]);
    await flush();
    let disposed = false;
    const closing = h.scheduler.dispose().then(() => { disposed = true; });
    await flush();
    expect(disposed).toBe(false);
    expect(h.started).toEqual([1, 2]);
    await expect(h.add(4)).rejects.toThrow("closed");
    for (const id of [1, 2]) h.controls.get(id)!.resolve({ value: id, bytes: 100 });
    await closing;
    expect((await results)[2]?.status).toBe("rejected");
  });
});
