import { describe, expect, it } from "vitest";
import { median, assertComparable, validateReport, renderReport, successful, type Report } from "./report";
import { scenarios } from "./profiles";
import { SyncMetrics } from "./metrics";
function report(): Report {
  return {
    schemaVersion: 1, kind: "run", runtime: "node", definition: "a".repeat(64),
    source: { commit: "b".repeat(40), dirtyHash: null, lockfile: "c".repeat(64) }, environment: { node: "v24" },
    options: { iterations: 1, warmup: 0, isolation: "fresh-process/prepared-session" },
    scenarios: [{ scenario: scenarios[0], samples: [{ rehearsal: false, status: "passed", error: null, preparationMs: 10, verificationMs: 5,
      fixture: { fingerprint: "d".repeat(64), files: 1, bytes: 100, changedBytes: 100 }, policy: { storageLimitBytes: 0, maxFileSizeBytes: 0 },
      metrics: { ...new SyncMetrics().snapshot(), totalMs: 100, pageRequests: 1, downloadRequests: 1, downloadedBytes: 100 },
    }] }],
  };
}
describe("durable comparison results", () => {
  it("rejects changed workload, runtime, definition and fixture semantics", () => {
    for (const mutate of [
      (r: Report) => { r.runtime = "cloudflare"; },
      (r: Report) => { r.definition = "e".repeat(64); },
      (r: Report) => { r.scenarios[0].scenario.pageDelayMs = 40; },
      (r: Report) => { r.scenarios[0].samples[0].fixture!.bytes++; },
    ]) {
      const base = structuredClone(report()), candidate = structuredClone(base); mutate(candidate);
      expect(() => assertComparable(base, candidate)).toThrow("Incompatible");
    }
  });
  it("retains failures without claiming a speedup from remaining samples", () => {
    const base = structuredClone(report()), candidate = structuredClone(base);
    candidate.options.iterations = base.options.iterations = 2;
    candidate.scenarios[0].samples.push({ ...candidate.scenarios[0].samples[0], status: "failed", metrics: null, error: "failure" });
    expect(successful(candidate)).toBe(false);
    const text = renderReport({ schemaVersion: 1, kind: "comparison", base, candidate });
    expect(text).toContain("failed/incomplete"); expect(text).not.toContain("0.0%");
  });
  it("rejects non-finite measurements and Markdown injection in artifact identifiers", () => {
    const value = structuredClone(report()); value.scenarios[0].samples[0].metrics!.totalMs = NaN;
    expect(() => validateReport(value)).toThrow();
    value.scenarios[0].samples[0].metrics!.totalMs = 100;
    value.scenarios[0].scenario.id = "[click](https://example.com)";
    expect(() => validateReport(value)).toThrow();
  });
  it("summarizes runs with a median and no invented run-level p95", () => {
    expect(median([30, 10, 20, 40])).toBe(25); expect(median([])).toBeNull();
    expect(successful(report())).toBe(true);
  });
});
