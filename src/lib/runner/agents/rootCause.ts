import { RunContext, type CrawledPage } from "../context";
import type { RootCauseCluster } from "../../types";
import { urlTemplate } from "./crawler";

const AGENT = "root-cause";

/**
 * Deterministic correlation (Plan-v4 P7). Pure — no DB, no AI, selftestable.
 * Groups this run's failures by shared signature so the report reads causes,
 * not noise: one failing endpoint hit from 5 pages is ONE bug, not five.
 *  - API: same METHOD + url-template failing on ≥2 distinct pages.
 *  - Console: same normalized first-line error on ≥3 distinct pages.
 */
export function clusterFailures(
  pages: Pick<CrawledPage, "url" | "consoleErrors" | "failedRequests">[],
  templateOf: (u: string) => string
): RootCauseCluster[] {
  const clusters: RootCauseCluster[] = [];

  const api = new Map<string, { pages: Set<string>; statuses: Set<number> }>();
  for (const p of pages) {
    for (const r of p.failedRequests) {
      const sig = `${r.method} ${templateOf(r.url)}`;
      const e = api.get(sig) ?? { pages: new Set<string>(), statuses: new Set<number>() };
      e.pages.add(p.url);
      e.statuses.add(r.status);
      api.set(sig, e);
    }
  }
  for (const [sig, e] of api) {
    if (e.pages.size < 2) continue;
    const statuses = [...e.statuses].sort((a, b) => a - b).join("/");
    clusters.push({ kind: "api", signature: sig, pages: [...e.pages],
      detail: `${e.pages.size} pages share a failing request: ${sig} → HTTP ${statuses}. Fix this one endpoint and the failures on all of them likely clear together.` });
  }

  const con = new Map<string, Set<string>>();
  for (const p of pages) {
    const votedThisPage = new Set<string>();
    for (const err of p.consoleErrors) {
      const sig = normalizeError(err);
      if (!sig || votedThisPage.has(sig)) continue;
      votedThisPage.add(sig);
      const s = con.get(sig) ?? new Set<string>();
      s.add(p.url);
      con.set(sig, s);
    }
  }
  for (const [sig, s] of con) {
    if (s.size < 3) continue;
    clusters.push({ kind: "console", signature: sig, pages: [...s],
      detail: `${s.size} pages log the same console error: "${sig}". One shared cause (broken bundle, missing global, a failing shared fetch) is far more likely than ${s.size} independent bugs.` });
  }
  return clusters;
}

/** First line, with volatile ids/urls/numbers folded, so the same bug clusters across pages. */
function normalizeError(err: string): string {
  return err.split("\n")[0].replace(/https?:\/\/\S+/g, "URL").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Agent wrapper: clusters, stashes for the P6 senior reviewer, emits one high finding per cluster. */
export function rootCauseAgent(ctx: RunContext): void {
  const clusters = clusterFailures(ctx.pages, (u) => { try { return urlTemplate(u); } catch { return u; } });
  ctx.rootCauses = clusters;
  if (!clusters.length) {
    ctx.log(AGENT, "step", "No shared failure signatures — failures (if any) look independent.");
    return;
  }
  for (const c of clusters) {
    // ponytail: synthesis finding lists members; not back-marking each member
    // finding's row (no findings-update path). Add if per-finding cluster ids matter.
    ctx.finding({
      agent: AGENT, severity: "high", role: null, pageUrl: c.pages[0] ?? null,
      title: `${c.pages.length} pages broken by one cause: ${c.signature}`,
      detail: `${c.detail}\n\nAffected pages:\n${c.pages.slice(0, 12).map((u) => `• ${u}`).join("\n")}`,
      evidence: null,
    });
  }
  ctx.log(AGENT, "pass", `${clusters.length} root-cause cluster(s) found across the run's failures`);
}
