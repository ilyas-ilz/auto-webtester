import { RunContext } from "../context";
import { listFindings, previousRunFindings, findingHistory } from "../../db";
import type { Project, Finding } from "../../types";

const AGENT = "regression";
const RECURRENT_MIN = 3; // seen in ≥3 of the last N finished runs → "keeps happening"

/** Pure set-diff by fingerprint — exported so the self-test can exercise it. */
export function diffByFingerprint<T extends { fingerprint: string }>(prev: T[], curr: T[]): { isNew: T[]; resolved: T[] } {
  const prevFp = new Set(prev.map((f) => f.fingerprint));
  const currFp = new Set(curr.map((f) => f.fingerprint));
  return {
    isNew: curr.filter((f) => !prevFp.has(f.fingerprint)),
    resolved: prev.filter((f) => !currFp.has(f.fingerprint)),
  };
}

/**
 * Regression agent (Plan-v2 V13) — "what broke since last run." Diffs this
 * run's finding fingerprints against the previous finished run for the same
 * project. Emits info-severity summary findings (never flips pass/fail) so the
 * report shows regressions and fixes at a glance. Zero LLM cost.
 */
export function regressionAgent(ctx: RunContext, project: Project): void {
  const prev = previousRunFindings(project.id, ctx.runId);
  if (!prev) {
    ctx.log(AGENT, "step", "No previous run to compare against — baseline established.");
    return;
  }
  // Exclude the regression agent's own meta-findings from both sides, or their
  // ever-changing counts would churn as new/resolved on every subsequent run.
  const real = (f: Finding) => f.agent !== AGENT;
  const current = listFindings(ctx.runId).filter(real);
  const { isNew, resolved } = diffByFingerprint(prev.findings.filter(real), current);

  ctx.log(AGENT, "pass", `vs last run: ${isNew.length} new, ${resolved.length} resolved`);
  if (isNew.length) {
    ctx.finding({ agent: AGENT, severity: "info", kind: "bug", role: null, pageUrl: null,
      title: `${isNew.length} new issue(s) since last run`,
      detail: isNew.slice(0, 10).map((f) => `• [${f.severity}] ${f.title}`).join("\n"), evidence: null });
  }
  if (resolved.length) {
    ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: null,
      title: `${resolved.length} issue(s) resolved since last run`,
      detail: resolved.slice(0, 10).map((f) => `• [${f.severity}] ${f.title}`).join("\n"), evidence: null });
  }

  // Multi-run memory (P2): how often each current finding has recurred, and
  // which ones came back after being fixed. One finding per fingerprint.
  const history = findingHistory(project.id, current.map((f) => f.fingerprint));
  const byFp = new Map<string, Finding>();
  for (const f of current) if (!byFp.has(f.fingerprint)) byFp.set(f.fingerprint, f);
  const isNewFps = new Set(isNew.map((f) => f.fingerprint));

  const recurrent = [...byFp.values()]
    .map((f) => ({ f, h: history.get(f.fingerprint) }))
    .filter((x) => x.h && x.h.runsSeen >= RECURRENT_MIN)
    .sort((a, b) => (b.h!.runsSeen - a.h!.runsSeen))
    .map((x) => ({ title: x.f.title, runsSeen: x.h!.runsSeen, totalRuns: x.h!.totalRuns }));
  // Reappeared = new vs last run, yet present in an older finished run = a regression.
  const reappeared = [...byFp.values()]
    .filter((f) => isNewFps.has(f.fingerprint) && (history.get(f.fingerprint)?.runsSeen ?? 0) >= 1)
    .map((f) => ({ title: f.title }));

  ctx.patterns = { recurrent, reappeared };

  if (recurrent.length) {
    ctx.finding({ agent: AGENT, severity: "info", kind: "bug", role: null, pageUrl: null,
      title: `${recurrent.length} recurring issue(s) across recent runs`,
      detail: recurrent.slice(0, 10).map((r) => `• ${r.title} — seen in ${r.runsSeen} of the last ${r.totalRuns} runs`).join("\n"), evidence: null });
  }
  if (reappeared.length) {
    ctx.finding({ agent: AGENT, severity: "medium", kind: "bug", role: null, pageUrl: null,
      title: `Regression pattern: ${reappeared.length} issue(s) came back after being fixed`,
      detail: reappeared.slice(0, 10).map((r) => `• ${r.title}`).join("\n") + "\n\nThese were absent last run but appeared in an earlier run — a fix regressed.", evidence: null });
  }
}
