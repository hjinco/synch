export type Runtime = "node" | "cloudflare";
export type Scenario = {
  id: string;
  version: 1;
  fixture: "bulk" | "notes" | "mixed";
  operation: "pull" | "incremental" | "push";
  pageDelayMs: number;
  downloadDelayMs: number;
  uploadDelayMs: number;
  commitDelayMs: number;
  attachmentDelayMs: number;
};
const direct = { version: 1 as const, pageDelayMs: 0, downloadDelayMs: 0, uploadDelayMs: 0, commitDelayMs: 0, attachmentDelayMs: 0 };
export const scenarios: Scenario[] = [
  { ...direct, id: "initial-pull-1GiB", fixture: "bulk", operation: "pull" },
  { ...direct, id: "incremental-pull-64MiB", fixture: "bulk", operation: "incremental" },
  { ...direct, id: "queued-push-1GiB", fixture: "bulk", operation: "push" },
  ...[0, 40, 120].map(ms => ({ ...direct, id: ms ? `pull-notes-page-${ms}ms` : "pull-notes-no-delay", fixture: "notes" as const, operation: "pull" as const, pageDelayMs: ms, downloadDelayMs: ms ? 5 : 0 })),
  { ...direct, id: "push-mixed-no-delay", fixture: "mixed", operation: "push" },
  { ...direct, id: "push-mixed-latency", fixture: "mixed", operation: "push", uploadDelayMs: 40, commitDelayMs: 40 },
  { ...direct, id: "push-mixed-slow-attachment", fixture: "mixed", operation: "push", uploadDelayMs: 40, commitDelayMs: 40, attachmentDelayMs: 800 },
];
export const directScenario = { ...direct, id: "setup", fixture: "notes", operation: "push" } satisfies Scenario;
export function selectScenarios(suite: string, id?: string) {
  if (suite !== "quick" && suite !== "full") throw new Error(`Unknown suite: ${suite}`);
  if (id) {
    const selected = scenarios.find(s => s.id === id);
    if (!selected) throw new Error(`Unknown scenario: ${id}`);
    return [selected];
  }
  return scenarios.filter(s => suite === "full" || s.fixture !== "bulk");
}
