import type { Scenario, Runtime } from "./profiles";
import type { SyncMetrics } from "./metrics";
export type Metrics = ReturnType<SyncMetrics["snapshot"]> & { pageRequests: number; downloadRequests: number; downloadedBytes: number; effectiveMiBPerSec?: number };
export type Sample = {
  rehearsal: boolean; status: "passed" | "failed"; preparationMs: number; verificationMs: number;
  metrics: Metrics | null; error: string | null;
  fixture: { fingerprint: string; files: number; bytes: number; changedBytes: number } | null;
  policy: { storageLimitBytes: number; maxFileSizeBytes: number } | null;
};
export type Report = {
  schemaVersion: 1; kind: "run"; runtime: Runtime; definition: string;
  source: { commit: string; dirtyHash: string | null; lockfile: string };
  environment: Record<string, string | number>;
  options: { iterations: number; warmup: number; isolation: "fresh-process/prepared-session" };
  scenarios: { scenario: Scenario; samples: Sample[] }[];
};
export type Comparison = { schemaVersion: 1; kind: "comparison"; base: Report; candidate: Report };

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function assertComparable(base: Report, candidate: Report) {
  for (const field of ["runtime", "definition", "options", "environment"] as const) {
    if (JSON.stringify(base[field]) !== JSON.stringify(candidate[field])) throw new Error(`Incompatible comparison: ${field}`);
  }
  if (JSON.stringify(base.scenarios.map(s => s.scenario)) !== JSON.stringify(candidate.scenarios.map(s => s.scenario))) throw new Error("Incompatible comparison: scenarios");
  for (let i = 0; i < base.scenarios.length; i++) {
    const fingerprints = [...base.scenarios[i].samples, ...candidate.scenarios[i].samples].filter(s => s.status === "passed").map(s => JSON.stringify({ fixture: s.fixture, policy: s.policy }));
    if (new Set(fingerprints).size > 1) throw new Error("Incompatible comparison: fixture/policy");
  }
}

/** Validate untrusted CI artifacts before rendering. No source-controlled text becomes Markdown. */
export function validateReport(input: unknown): asserts input is Report | Comparison {
  const fail = (): never => { throw new Error("Invalid sync benchmark report"); };
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
  const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const fingerprint = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  const oneOf = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value);
  const value = record(input);
  if (value.schemaVersion !== 1) fail();
  if (value.kind === "comparison") {
    const base = value.base, candidate = value.candidate;
    validateReport(base); validateReport(candidate);
    if (base.kind !== "run" || candidate.kind !== "run") return fail();
    assertComparable(base, candidate);
    return;
  }
  if (value.kind !== "run" || !oneOf(value.runtime, ["node", "cloudflare"]) || !fingerprint(value.definition)) fail();
  const source = record(value.source), options = record(value.options), environment = record(value.environment);
  if (typeof source.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(source.commit)
    || !nonnegative(options.iterations) || !Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 100
    || !nonnegative(options.warmup) || !Number.isInteger(options.warmup) || options.warmup > 10) fail();
  if (!fingerprint(source.lockfile) || !(source.dirtyHash === null || fingerprint(source.dirtyHash))
    || options.isolation !== "fresh-process/prepared-session"
    || Object.values(environment).some(v => !(typeof v === "string" && v.length <= 2000) && !nonnegative(v))) fail();
  const groups = array(value.scenarios);
  if (groups.length > 30) fail();
  const ids = new Set<string>();
  for (const rawGroup of groups) {
    const group = record(rawGroup), scenario = record(group.scenario), samples = array(group.samples);
    if (typeof scenario.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(scenario.id)) return fail();
    if (ids.has(scenario.id) || samples.length > 110) fail();
    ids.add(scenario.id);
    if (scenario.bandwidth !== undefined) {
      const bandwidth = array(scenario.bandwidth);
      if (!bandwidth.length || bandwidth.length > 20) fail();
      let previous = -1;
      for (const [i, rawStep] of bandwidth.entries()) {
        const step = record(rawStep);
        if (!nonnegative(step.afterMs) || !nonnegative(step.bytesPerSecond) || step.bytesPerSecond === 0
          || (i === 0 ? step.afterMs !== 0 : step.afterMs <= previous)) return fail();
        previous = step.afterMs;
      }
    }
    if (scenario.version !== 1 || !oneOf(scenario.fixture, ["bulk", "notes", "mixed"])
      || !oneOf(scenario.operation, ["pull", "push", "incremental"])
      || ["pageDelayMs", "downloadDelayMs", "uploadDelayMs", "commitDelayMs", "attachmentDelayMs"].some(k => !nonnegative(scenario[k]))) fail();
    for (const rawSample of samples) {
      const sample = record(rawSample);
      if (!oneOf(sample.status, ["passed", "failed"]) || typeof sample.rehearsal !== "boolean") fail();
      if (!(sample.error === null || typeof sample.error === "string" && sample.error.length <= 4000)) fail();
      if (sample.fixture !== null) {
        const fixture = record(sample.fixture);
        if (!fingerprint(fixture.fingerprint) || ![fixture.files, fixture.bytes, fixture.changedBytes].every(nonnegative)) fail();
      }
      if (sample.policy !== null) {
        const policy = record(sample.policy);
        if (![policy.storageLimitBytes, policy.maxFileSizeBytes].every(nonnegative)) fail();
      }
      if (sample.status === "passed" && (!sample.metrics || !sample.fixture || !sample.policy)) fail();
      const metrics = sample.metrics == null ? {} : record(sample.metrics);
      for (const n of [sample.preparationMs, sample.verificationMs, ...Object.values(metrics)]) {
        if (n !== null && !nonnegative(n)) fail();
      }
      if (sample.status === "passed" && (!nonnegative(metrics.totalMs) || metrics.totalMs <= 0)) fail();
    }
  }
}
export function successful(report: Report): boolean {
  return report.scenarios.length > 0 && report.scenarios.every(g => g.samples.length === report.options.iterations + report.options.warmup && g.samples.every(s => s.status === "passed") && g.samples.filter(s => !s.rehearsal).length === report.options.iterations);
}
export function renderReport(input: Report | Comparison): string {
  validateReport(input);
  const reports = input.kind === "comparison" ? [input.base, input.candidate] : [input];
  let text = `<!-- synch-sync-client-benchmark -->\n## Sync benchmark (${reports[0].runtime})\n\n`;
  text += "Real local server; Node client, filesystem vault, in-memory store. Fresh processes and prepared sessions.\n\n";
  text += "| Scenario | Base median | Candidate median | Candidate min–max | Change | Samples |\n| --- | ---: | ---: | ---: | ---: | ---: |\n";
  const current = reports.at(-1)!;
  for (let i = 0; i < current.scenarios.length; i++) {
    const values = (r: Report) => r.scenarios[i].samples.filter(s => !s.rehearsal && s.status === "passed").map(s => s.metrics!.totalMs);
    const before = input.kind === "comparison" ? median(values(input.base)) : null;
    const timings = values(current);
    const after = median(timings);
    const range = timings.length ? `${Math.min(...timings).toFixed(1)}–${Math.max(...timings).toFixed(1)} ms` : "—";
    const complete = reports.every(r => successful({ ...r, scenarios: [r.scenarios[i]] }));
    const delta = complete && before && after ? `${((after / before - 1) * 100).toFixed(1)}%` : "—";
    text += `| ${current.scenarios[i].scenario.id} | ${before?.toFixed(1) ?? "—"} ms | ${after?.toFixed(1) ?? "—"} ms | ${range} | ${delta} | ${values(current).length}/${current.options.iterations}${complete ? "" : " (failed/incomplete)"} |\n`;
  }
  text += "\nNegative change means faster. Partial/failed runs are not valid performance comparisons. Raw JSON includes individual timings, completion metrics and sampled client RSS.\n";
  for (const [i, report] of reports.entries()) text += `\n${reports.length === 2 ? (i ? "Candidate" : "Base") : "Source"}: ${report.source.commit}${report.source.dirtyHash ? ` (working tree ${report.source.dirtyHash.slice(0, 12)})` : ""}\n`;
  return text;
}
