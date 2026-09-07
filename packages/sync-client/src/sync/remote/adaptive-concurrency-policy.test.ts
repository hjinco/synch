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
  it("keeps a probe only if throughput improves without excessive latency", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    policy.observe(window(1_000), 2_000);
    expect(policy.limit).toBe(3);
    policy.observe(window(1_300), 4_000);
    expect(policy.limit).toBe(3);
    policy.observe(window(1_300), 6_000);
    expect(policy.limit).toBe(3);
    policy.observe(window(1_300), 14_000);
    expect(policy.limit).toBe(4);
    policy.observe(window(1_800, 1_100), 16_000);
    expect(policy.limit).toBe(3);
  });

  it("rolls back a plateau and retries after cooldown", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    policy.observe(window(1_000), 2_000);
    policy.observe(window(1_020), 4_000);
    expect(policy.limit).toBe(2);
    policy.observe(window(1_000), 14_000);
    expect(policy.limit).toBe(3);
  });

  it("reduces once per failure burst, preserves the reduction across idle, and recovers", () => {
    const policy = new AdaptiveConcurrencyPolicy();
    policy.observe(window(1_000), 2_000);
    policy.observe(window(1_400), 4_000);
    policy.observe(window(1_400), 14_000);
    expect(policy.limit).toBe(4);
    policy.congested(15_000);
    expect(policy.limit).toBe(2);
    policy.congested(15_001);
    policy.idle();
    expect(policy.limit).toBe(2);
    policy.observe(window(500), 18_000);
    expect(policy.limit).toBe(2);
    policy.observe(window(500), 25_000);
    expect(policy.limit).toBe(3);
  });

  it("abandons interrupted probes and respects bounds", () => {
    const policy = new AdaptiveConcurrencyPolicy(3);
    policy.observe(window(1_000), 2_000);
    policy.idle();
    expect(policy.limit).toBe(2);
    policy.observe(window(1_000), 20_000);
    policy.observe(window(2_000), 22_000);
    policy.observe(window(2_000), 40_000);
    expect(policy.limit).toBe(3);
    policy.congested(41_000);
    policy.congested(51_000);
    expect(policy.limit).toBe(1);
  });
});
