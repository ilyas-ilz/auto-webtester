// Knowledge graph helpers (Plan-v2 §3.3). Discovery agents call these; they
// never assert — verification agents and the planner read the graph back.
import { upsertGraphNode, upsertGraphEdge, listGraphNodes } from "../db";
import type { CrawledPage } from "./context";

const HIGH_RISK = /(login|auth|password|payment|billing|checkout|admin|invoice|payroll|delete|transfer)/i;
const MED_RISK = /(account|profile|settings|user|order|approve|role|permission)/i;

export function riskScore(pathname: string): number {
  if (HIGH_RISK.test(pathname)) return 90;
  if (MED_RISK.test(pathname)) return 50;
  return 20;
}

/**
 * Risk-weighted page sampling (Plan-v4 P1, Plan-v5 R3). Pure — testable without a DB.
 * Score = riskScore(path) + 40 (new) / 20 (changed) from the change-detection
 * rank the crawl already computed + 30 (adaptive: this page carried a finding in
 * a recent run — `hotPaths` holds those pathnames). Two passes guarantee type
 * diversity: pass 1 takes the highest-scoring representative of each distinct page
 * type, pass 2 fills remaining slots with the next-highest pages. So a sample of 6
 * covers up to 6 page types AND always includes the riskiest/historically-broken
 * pages — never six list pages.
 */
export function rankPages(pages: CrawledPage[], n: number, pageTypes?: Map<string, string>, hotPaths?: Set<string>): CrawledPage[] {
  const score = (p: CrawledPage): number =>
    riskScore(safePathname(p.url)) +
    (p.changeRank === 0 ? 40 : p.changeRank === 1 ? 20 : 0) +
    (hotPaths?.has(safePathname(p.url)) ? 30 : 0);
  const sorted = [...pages].sort((a, b) => score(b) - score(a));
  if (n >= sorted.length || !pageTypes || pageTypes.size === 0) return sorted.slice(0, n);

  const picked: CrawledPage[] = [];
  const seen = new Set<CrawledPage>();
  const typesTaken = new Set<string>();
  for (const p of sorted) { // pass 1: one best page per type
    if (picked.length >= n) break;
    const t = pageTypes.get(p.url);
    if (t && !typesTaken.has(t)) { typesTaken.add(t); picked.push(p); seen.add(p); }
  }
  for (const p of sorted) { // pass 2: fill with the next highest-scoring pages
    if (picked.length >= n) break;
    if (!seen.has(p)) { picked.push(p); seen.add(p); }
  }
  return picked.sort((a, b) => score(b) - score(a));
}

export function recordPageNode(projectId: string, runId: string, url: string, label: string): number {
  // label "" means "unknown yet" (link discovered but not crawled) — pass it
  // through as-is; upsertGraphNode falls back to the key without clobbering
  // a real title recorded elsewhere. See its comment for why this matters.
  const pathname = safePathname(url);
  return upsertGraphNode({ projectId, type: "page", key: pathname, label, riskScore: riskScore(pathname), attrs: { url }, lastSeenRun: runId });
}

export function recordNavEdge(projectId: string, fromNodeId: number, toNodeId: number): void {
  if (fromNodeId === toNodeId) return;
  upsertGraphEdge({ projectId, fromNode: fromNodeId, toNode: toNodeId, type: "navigates_to" });
}

export function recordApiNode(projectId: string, runId: string, method: string, url: string, status: number): number {
  const pathname = safePathname(url);
  const key = `${method} ${pathname}`;
  return upsertGraphNode({ projectId, type: "api", key, label: key, riskScore: riskScore(pathname), attrs: { url, lastStatus: status }, lastSeenRun: runId });
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

// ---- change detection (Plan-v2 §3.3, "the cost-killer") ----
// Cheap re-runs, not skipped ones: rather than excluding unchanged pages from
// testing (which would silently shrink coverage), new/changed pages are
// sorted to the front of ctx.pages so size-limited samples (quick/smart mode)
// spend their budget on what's different since last run. Full mode's larger
// sample still reaches everything else. Must snapshot BEFORE this run's
// crawl overwrites graph_nodes — see executeRun call order.

/** Snapshot of {pathname → label} for every known page node, taken before this run's crawl. */
export function snapshotPageLabels(projectId: string): Map<string, string> {
  return new Map(listGraphNodes(projectId, "page").map((n) => [n.key, n.label]));
}

/** Sorts `pages` in place (new/changed first) and reports counts. Pure — testable without a DB. */
export function reorderByChangeStatus(pages: CrawledPage[], priorLabels: Map<string, string>): { newCount: number; changedCount: number } {
  const rank = (p: CrawledPage): number => {
    const prior = priorLabels.get(safePathname(p.url));
    if (prior === undefined) return 0; // new
    return prior !== p.title ? 1 : 2; // changed vs unchanged
  };
  const ranks = new Map(pages.map((p) => [p, rank(p)]));
  for (const p of pages) p.changeRank = ranks.get(p)!; // stash for risk sampling (P1)
  pages.sort((a, b) => ranks.get(a)! - ranks.get(b)!);
  return {
    newCount: [...ranks.values()].filter((r) => r === 0).length,
    changedCount: [...ranks.values()].filter((r) => r === 1).length,
  };
}
