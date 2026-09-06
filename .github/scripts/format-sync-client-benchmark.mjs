import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderReport } from "../../benchmarks/sync/src/report.ts";

const [directory, output] = process.argv.slice(2);
let text = "<!-- synch-sync-client-benchmark -->\n";
let failed = false;
try {
  const files = (await readdir(directory)).filter(name => /^sync-benchmark-(node|cloudflare)\.json$/.test(name)).sort();
  if (files.length !== 2) { text += "\nOne or more runtime reports are missing. See workflow logs.\n"; failed = true; }
  for (const file of files) {
    if ((await stat(join(directory, file))).size > 5 * 1024 * 1024) throw new Error("Oversized report");
    const report = JSON.parse(await readFile(join(directory, file), "utf8"));
    text += "\n" + renderReport(report).replace("<!-- synch-sync-client-benchmark -->\n", "");
  }
} catch {
  text += "\nBenchmark report is missing or invalid. See workflow logs and raw artifacts.\n";
  failed = true;
}
await writeFile(output, text);
if (failed) process.exitCode = 1;
