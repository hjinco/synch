import { describe, expect, it } from "vitest";
import { AdaptiveConcurrencyPolicy } from "./adaptive-concurrency-policy";

const window = (bytes: number, meanDurationMs = 500) => ({ bytes, elapsedMs: 2_000, meanDurationMs });

describe("AdaptiveConcurrencyPolicy", () => {
  it("backs off on sustained throughput loss and latency growth even at the ceiling", () => {
    const policy = new AdaptiveConcurrencyPolicy(2);
    policy.observe(window(1_000), 2_000);
    policy.observe(window(500, 1_000), 4_000);
    expect(policy.limit).toBe(2);
    policy.observe(window(500, 1_000), 6_000);
    expect(policy.limit).toBe(1);
  });
  it("starts with bounded parallelism and keeps increasing after successful probes", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    expect(policy.limit).toBe(8);
    policy.observe(window(1_000), 2_000);
    expect(policy.limit).toBe(9);
    policy.observe(window(1_300), 4_000);
    expect(policy.limit).toBe(9);
    policy.observe(window(1_300), 6_000);
    expect(policy.limit).toBe(10);
    policy.observe(window(1_800, 1_100), 8_000);
    expect(policy.limit).toBe(9);
  });

  it("rolls back a plateau and retries after cooldown", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    policy.observe(window(1_000), 2_000);
    policy.observe(window(1_020), 4_000);
    expect(policy.limit).toBe(8);
    policy.observe(window(1_000), 6_000);
    expect(policy.limit).toBe(8);
    policy.observe(window(1_000), 14_000);
    expect(policy.limit).toBe(9);
  });

  it("reduces once per failure burst, preserves the reduction across idle, and recovers", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    policy.congested(0);
    expect(policy.limit).toBe(4);
    policy.congested(1);
    policy.idle();
    expect(policy.limit).toBe(4);
    policy.observe(window(500), 2_000);
    expect(policy.limit).toBe(4);
    policy.observe(window(500), 10_000);
    expect(policy.limit).toBe(5);
    policy.observe(window(700), 12_000);
    policy.observe(window(700), 14_000);
    expect(policy.limit).toBe(6);
  });

  it("abandons interrupted probes and respects bounds", () => {
    const policy = new AdaptiveConcurrencyPolicy(9);
    policy.observe(window(1_000), 2_000);
    policy.idle();
    expect(policy.limit).toBe(8);
    policy.observe(window(1_000), 20_000);
    policy.observe(window(2_000), 22_000);
    policy.observe(window(2_000), 40_000);
    expect(policy.limit).toBe(9);
    for (let now = 41_000; now < 70_000; now += 5_000) policy.congested(now);
    expect(policy.limit).toBe(1);
  });
});
