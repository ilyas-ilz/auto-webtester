/**
 * Human feedback loop (Plan-v8 §3) — a reviewer marks a finding false-positive
 * once, and it's suppressed (never silently dropped) forever, with the reason on
 * record. Highest value per line of code in the whole plan.
 *
 * §3.2: does NOT mint a second fingerprint. `context.ts:finding()` already computes
 * one (sha1 of agent|title|pageUrl) that `regression.ts` and `repo.ts` key off — a
 * second competing identity would drift from it. Instead this normalizes the INPUTS
 * to that existing computation, fixing the same instability that made regression
 * diffs flap on dynamic titles/URLs.
 */

import { generalizeSubject } from "./experience";
import { saveFeedbackRow, getFeedbackRow, listFeedbackForOrigin, getRun, getProject, listFindings, type FeedbackRow as DbFeedbackRow } from "../db";

export type FeedbackVerdict = "confirmed" | "false_positive" | "intended";

/** Pure — selftested. `/users/42` and `/users/43` (or a uuid) become the same route. */
function normalizeUrl(url: string | null): string {
  if (!url) return "";
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const segs = u.pathname.split("/").map((s) => {
    if (!s) return s;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ":id";
    if (/^\d+$/.test(s)) return ":id";
    return s;
  });
  return `${u.origin}${segs.join("/")}`; // query string and hash fragment deliberately dropped
}

/** Pure — selftested. Interpolated dynamic text ("Order #4521 failed") must not mint a
 * new identity per instance. Reuses §2's selector-generalization for any selector
 * embedded in the title, then remaps its digit/uuid placeholders to a title-appropriate `#`. */
function normalizeTitle(title: string): string {
  return generalizeSubject(title).replace(/:n\b/g, "#").replace(/:uuid\b/g, "#");
}

/** Pure — selftested. The stable normalization `context.ts` hashes into the existing
 * fingerprint — same identity for a finding whose only difference is a dynamic id/count. */
export function normalizeForFingerprint(agent: string, title: string, pageUrl: string | null): { agent: string; title: string; pageUrl: string } {
  return { agent, title: normalizeTitle(title), pageUrl: normalizeUrl(pageUrl) };
}

export interface FeedbackEntry { verdict: FeedbackVerdict; reason: string }

/** Pure — selftested. Never deletes: suppressed findings are re-bucketed for display,
 * the underlying `findings` row is untouched — auditability per the plan's global invariant. */
export function partitionByFeedback<T extends { fingerprint: string }>(
  findings: readonly T[],
  feedback: ReadonlyMap<string, FeedbackEntry>,
): { visible: T[]; suppressed: { finding: T; reason: string }[]; confirmed: Set<string> } {
  const visible: T[] = [];
  const suppressed: { finding: T; reason: string }[] = [];
  const confirmed = new Set<string>();
  for (const f of findings) {
    const fb = feedback.get(f.fingerprint);
    if (fb && (fb.verdict === "false_positive" || fb.verdict === "intended")) {
      suppressed.push({ finding: f, reason: fb.reason || `marked ${fb.verdict.replace("_", " ")}` });
      continue;
    }
    if (fb?.verdict === "confirmed") confirmed.add(f.fingerprint);
    visible.push(f);
  }
  return { visible, suppressed, confirmed };
}

// ---- db.ts wiring (impure) --------------------------------------------------

export function loadFeedbackMap(origin: string): Map<string, FeedbackEntry> {
  const map = new Map<string, FeedbackEntry>();
  for (const row of listFeedbackForOrigin(origin)) map.set(row.findingFingerprint, { verdict: row.verdict as FeedbackVerdict, reason: row.reason });
  return map;
}

export function recordFeedback(origin: string, fingerprint: string, verdict: FeedbackVerdict, reason: string): void {
  saveFeedbackRow({ origin, findingFingerprint: fingerprint, verdict, reason, createdAt: Date.now() });
}

export function getFeedback(origin: string, fingerprint: string): DbFeedbackRow | null {
  return getFeedbackRow(origin, fingerprint);
}

export type ApproveFindingResult =
  | { ok: true; origin: string; findingTitle: string }
  | { ok: false; error: string };

/**
 * Shared by the CLI (`npm run agents -- feedback`) and the MCP `approve_finding`
 * tool (§5.1) — one implementation, so the two entry points can't drift.
 */
export function recordFeedbackForFinding(runId: string, findingId: number, verdict: FeedbackVerdict, reason: string): ApproveFindingResult {
  const run = getRun(runId);
  if (!run) return { ok: false, error: `No such run: ${runId}` };
  const project = getProject(run.projectId);
  if (!project) return { ok: false, error: `No such project for run ${runId}` };
  const finding = listFindings(runId).find((f) => f.id === findingId);
  if (!finding) return { ok: false, error: `No finding #${findingId} in run ${runId}` };
  const origin = new URL(project.baseUrl).origin;
  recordFeedback(origin, finding.fingerprint, verdict, reason);
  return { ok: true, origin, findingTitle: finding.title };
}
