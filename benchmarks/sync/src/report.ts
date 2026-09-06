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
  if (!input || typeof input !== "object") fail();
  const value = input as any;
  if (value.schemaVersion !== 1) fail();
  if (value.kind === "comparison") {
    validateReport(value.base); validateReport(value.candidate);
    if (value.base.kind !== "run" || value.candidate.kind !== "run") fail();
    assertComparable(value.base, value.candidate);
    return;
  }
  if (value.kind !== "run" || !["node", "cloudflare"].includes(value.runtime) || typeof value.definition !== "string" || !/^[a-f0-9]{64}$/.test(value.definition)) fail();
  if (!value.source || !/^[a-f0-9]{40,64}$/.test(value.source.commit) || !value.options || !Number.isInteger(value.options.iterations) || value.options.iterations < 1 || value.options.iterations > 100 || !Number.isInteger(value.options.warmup) || value.options.warmup < 0 || value.options.warmup > 10) fail();
  const nonnegative = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const fingerprint = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (!fingerprint(value.source.lockfile) || !(value.source.dirtyHash === null || fingerprint(value.source.dirtyHash)) || value.options.isolation !== "fresh-process/prepared-session" || !value.environment || typeof value.environment !== "object" || Object.values(value.environment).some(v => !(typeof v === "string" && v.length <= 2000) && !nonnegative(v))) fail();
  if (!Array.isArray(value.scenarios) || value.scenarios.length > 30) fail();
  if (new Set(value.scenarios.map((g: any) => g?.scenario?.id)).size !== value.scenarios.length) fail();
  for (const group of value.scenarios) {
    if (!group.scenario || !/^[a-zA-Z0-9-]{1,80}$/.test(group.scenario.id) || !Array.isArray(group.samples) || group.samples.length > 110) fail();
    if (group.scenario.version !== 1 || !["bulk", "notes", "mixed"].includes(group.scenario.fixture) || !["pull", "push", "incremental"].includes(group.scenario.operation) || ["pageDelayMs", "downloadDelayMs", "uploadDelayMs", "commitDelayMs", "attachmentDelayMs"].some(k => !nonnegative(group.scenario[k]))) fail();
    for (const sample of group.samples) {
      if (!["passed", "failed"].includes(sample.status) || typeof sample.rehearsal !== "boolean") fail();
      if (!(sample.error === null || typeof sample.error === "string" && sample.error.length <= 4000)) fail();
      if (sample.fixture !== null && (!fingerprint(sample.fixture?.fingerprint) || ![sample.fixture.files, sample.fixture.bytes, sample.fixture.changedBytes].every(nonnegative))) fail();
      if (sample.policy !== null && ![sample.policy?.storageLimitBytes, sample.policy?.maxFileSizeBytes].every(nonnegative)) fail();
      if (sample.status === "passed" && (!sample.metrics || !sample.fixture || !sample.policy)) fail();
      for (const n of [sample.preparationMs, sample.verificationMs, ...Object.values(sample.metrics ?? {})]) {
        if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) fail();
      }
      if (sample.status === "passed" && (!Number.isFinite(sample.metrics.totalMs) || sample.metrics.totalMs <= 0)) fail();
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
