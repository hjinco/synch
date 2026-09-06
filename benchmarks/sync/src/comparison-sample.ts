import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertComparable, validateReport, type Report, type Sample } from "./report";

/** Own one command's output so an earlier result can never satisfy a later run. */
export async function runComparisonSample(
  temporary: string,
  expected: Report,
  rehearsal: boolean,
  execute: (output: string) => Promise<unknown>,
): Promise<Sample> {
  const output = join(await mkdtemp(join(temporary, "sample-")), "report.json");
  const errors: string[] = [];
  try { await execute(output); }
  catch (error) { errors.push(`Sample command failed: ${String(error)}`); }

  let result: Sample;
  try {
    const report: unknown = JSON.parse(await readFile(output, "utf8"));
    validateReport(report);
    if (report.kind !== "run" || report.scenarios.length !== 1 || report.scenarios[0].samples.length !== 1) throw new Error("Missing comparison sample");
    assertComparable(expected, report);
    result = { ...report.scenarios[0].samples[0], rehearsal };
  } catch (error) {
    errors.push(`Sample report failed: ${String(error)}`);
    result = { rehearsal, status: "failed", preparationMs: 0, verificationMs: 0, metrics: null, error: null, fixture: null, policy: null };
  }
  if (errors.length) {
    result.status = "failed";
    result.error = [result.error, ...errors].filter(Boolean).join("; ").slice(0, 2000);
  }
  return result;
}
