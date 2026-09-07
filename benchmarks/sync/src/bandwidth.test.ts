import { afterEach, expect, it, vi } from "vitest";
import { SharedBandwidth } from "./bandwidth";

afterEach(() => vi.useRealTimers());

it("shares one budget, allowing small bodies past a large attachment", async () => {
  vi.useFakeTimers();
  const link = new SharedBandwidth([{ afterMs: 0, bytesPerSecond: 1000 }], () => Date.now());
  let large = false;
  let small = false;
  void link.transfer(900).then(() => { large = true; });
  void link.transfer(100).then(() => { small = true; });
  await vi.advanceTimersByTimeAsync(190);
  expect(small).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(small).toBe(true);
  expect(large).toBe(false);
  await vi.advanceTimersByTimeAsync(790);
  expect(large).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(large).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("integrates a capacity change for already active transfers", async () => {
  vi.useFakeTimers();
  const link = new SharedBandwidth([{ afterMs: 0, bytesPerSecond: 1000 }, { afterMs: 500, bytesPerSecond: 500 }], () => Date.now());
  let done = false;
  void link.transfer(1000).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(1490);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(done).toBe(true);
});

it("does not bank idle capacity or charge a new body for time before admission", async () => {
  vi.useFakeTimers();
  const link = new SharedBandwidth([{ afterMs: 0, bytesPerSecond: 1000 }], () => Date.now());
  await vi.advanceTimersByTimeAsync(10_000);
  let done = false;
  void link.transfer(100).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(50);
  let second = false;
  void link.transfer(100).then(() => { second = true; });
  await vi.advanceTimersByTimeAsync(90);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(done).toBe(true);
  expect(second).toBe(false);
  await vi.advanceTimersByTimeAsync(50);
  expect(second).toBe(true);
});

it("rejects invalid schedules", () => {
  for (const steps of [[], [{ afterMs: 0, bytesPerSecond: 0 }], [{ afterMs: 1, bytesPerSecond: 1 }], [{ afterMs: 0, bytesPerSecond: 1 }, { afterMs: 0, bytesPerSecond: 2 }]]) {
    expect(() => new SharedBandwidth(steps)).toThrow("Invalid bandwidth schedule");
  }
});
