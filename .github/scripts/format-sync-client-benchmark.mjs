import { readFile, writeFile } from "node:fs/promises";

const [reportPath, commentPath] = process.argv.slice(2);
const marker = "<!-- synch-sync-client-benchmark -->";
const status = process.env.BENCHMARK_STATUS ?? "success";

let body = `${marker}\n## Sync-client benchmark\n\n`;

if (status !== "success") {
  body += "⚠️ The benchmark command failed. See the workflow log for details.\n\n";
}

try {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const benchmarks = report.files.flatMap((file) =>
    file.groups.flatMap((group) => group.benchmarks),
  );

  body +=
    "| Scenario | Mean | Min | Max | RME | Samples |\n" +
    "| --- | ---: | ---: | ---: | ---: | ---: |\n";

  for (const benchmark of benchmarks) {
    body += `| ${benchmark.name} | ${formatMilliseconds(benchmark.mean)} | ` +
      `${formatMilliseconds(benchmark.min)} | ${formatMilliseconds(benchmark.max)} | ` +
      `${formatPercent(benchmark.rme)} | ${benchmark.sampleCount} |\n`;
  }

  body +=
    "\nFixture: 1 GiB plaintext dataset, generated fresh for this workflow run.\n";
} catch {
  body += "Benchmark report was not produced.\n";
}

await writeFile(commentPath, body);

function formatMilliseconds(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(2)} ms`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `±${value.toFixed(1)}%`;
}
