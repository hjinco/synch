import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runComparisonSample } from "./comparison-sample";
import { SyncMetrics } from "./metrics";
import { scenarios } from "./profiles";
import { renderReport, successful, validateReport, type Report } from "./report";

let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(join(tmpdir(), "synch-comparison-test-")); });
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

function report(): Report {
  return {
    schemaVersion: 1, kind: "run", runtime: "node", definition: "a".repeat(64),
    source: { commit: "b".repeat(40), dirtyHash: null, lockfile: "c".repeat(64) }, environment: { node: "v24" },
    options: { iterations: 1, warmup: 0, isolation: "fresh-process/prepared-session" },
    scenarios: [{ scenario: scenarios[3], samples: [{ rehearsal: false, status: "passed", error: null, preparationMs: 10, verificationMs: 5,
      fixture: { fingerprint: "d".repeat(64), files: 1, bytes: 100, changedBytes: 100 }, policy: { storageLimitBytes: 0, maxFileSizeBytes: 0 },
      metrics: { ...new SyncMetrics().snapshot(), totalMs: 100, pageRequests: 1, downloadRequests: 1, downloadedBytes: 100 },
    }] }],
  };
}

it("does not reuse a previous success when the next command fails before writing", async () => {
  const expected = report();
  let previousOutput = "";
  const first = await runComparisonSample(temporary, expected, true, async output => {
    previousOutput = output;
    await writeFile(output, JSON.stringify(expected));
  });
  expect(first).toEqual({ ...expected.scenarios[0].samples[0], rehearsal: true });
  const second = await runComparisonSample(temporary, expected, false, async output => {
    expect(output).not.toBe(previousOutput);
    throw new Error("startup interrupted");
  });
  expect(JSON.parse(await readFile(previousOutput, "utf8"))).toEqual(expected);
  expect(second).toMatchObject({ status: "failed", rehearsal: false, metrics: null });
  expect(second.error).toContain("startup interrupted");
  const completed = report();
  completed.options.warmup = 1;
  completed.scenarios[0].samples = [first, second];
  validateReport(completed);
  expect(successful(completed)).toBe(false);
});

it("invalidates a successful report when the command subsequently exits with an error", async () => {
  const expected = report();
  const result = await runComparisonSample(temporary, expected, false, async output => {
    await writeFile(output, JSON.stringify(expected));
    throw new Error("child exited 1");
  });
  expect(result.status).toBe("failed");
  expect(result.metrics).toEqual(expected.scenarios[0].samples[0].metrics);
  expect(result.error).toContain("child exited 1");
  const candidate = report();
  candidate.scenarios[0].samples = [result];
  expect(successful(candidate)).toBe(false);
  const text = renderReport({ schemaVersion: 1, kind: "comparison", base: expected, candidate });
  expect(text).toContain("failed/incomplete");
  expect(text).not.toContain("0.0%");
});

it("preserves worker failure diagnostics alongside the command failure", async () => {
  const failed = report();
  failed.scenarios[0].samples[0].status = "failed";
  failed.scenarios[0].samples[0].error = "Content mismatch";
  const result = await runComparisonSample(temporary, report(), false, async output => {
    await writeFile(output, JSON.stringify(failed));
    throw new Error("child exited 1");
  });
  expect(result.error).toContain("Content mismatch");
  expect(result.error).toContain("child exited 1");
});

it.each(["missing", "partial", "invalid", "incompatible"])("records a %s report as a failed sample", async kind => {
  const result = await runComparisonSample(temporary, report(), false, async output => {
    if (kind === "missing") return;
    const value = report();
    if (kind === "partial") value.scenarios[0].samples = [];
    if (kind === "incompatible") value.runtime = "cloudflare";
    await writeFile(output, kind === "invalid" ? "{" : JSON.stringify(value));
  });
  expect(result).toMatchObject({ status: "failed", metrics: null });
  expect(result.error).toContain("Sample report failed");
  const completed = report();
  completed.scenarios[0].samples = [result];
  validateReport(completed);
  expect(successful(completed)).toBe(false);
});
