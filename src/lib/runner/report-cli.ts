// CLI: npm run report -- --run <runId>   (omit --run for the latest finished run)
import { loadEnvLocal } from "./env";
loadEnvLocal();
import { latestFinishedRunId } from "../db";
import { generateReportDocs } from "./report-doc";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--run");
  const runId = (i >= 0 ? process.argv[i + 1] : undefined) ?? latestFinishedRunId() ?? undefined;
  if (!runId) { console.error("No finished runs found. Usage: npm run report -- --run <runId>"); process.exit(1); }
  const out = await generateReportDocs(runId);
  if (!out) { console.error(`Run ${runId} not found.`); process.exit(1); }
  console.log(`Report written:\n  MD:  ${out.md}\n  PDF: ${out.pdf ?? "(skipped — Chromium unavailable)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
