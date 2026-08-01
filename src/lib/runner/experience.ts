/**
 * Cross-run experience (Plan-v8 §1) + global patterns (§2) — "next run against the
 * same origin starts with everything previous runs learned." NOT a new subsystem:
 * one `experience` table, `scope='site'` rows recall per-origin, `scope='global'`
 * rows (§2) are the same recovery rows promoted once they generalize across sites.
 *
 * Kept separate from FactStore (facts.ts): FactStore is this run's live belief
 * state; experience is what persists across runs and re-seeds it (see recallFacts).
 *
 * Split like lifecycle.ts/learning.ts: the merge/contradiction/promotion DECISIONS
 * below are pure functions over ExperienceRow[] (selftested without a database);
 * `saveExperience`/`loadExperience` are the thin, un-pure db.ts wiring.
 */

import {
  getExperienceRow, putExperienceRow, listExperienceForOrigin, pruneStaleExperience,
  listSiteRecoveryRows, listConflictingFactRows, type ExperienceRow,
} from "../db";
import type { FactStore, FactSource } from "./facts";
import type { RunContext } from "./context";

const MIN_FACT_CONFIDENCE = 0.6;
const DECAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RECALL_CAP = 200;
const RECALL_CONFIDENCE_FLOOR = 0.4; // below this a fact stops seeding — re-opens probing (§1.2 poison-guard)
const CONTRADICTION_TRUST_FLOOR = 0.7; // a recovery this reliable failing is a real contradiction, not noise
const PROMOTION_MIN_ORIGINS = 3;
const PROMOTION_MIN_RATE = 0.7;

/**
 * Pure — selftested. Strips origin-specific identifiers from a selector/subject
 * string so the same control on different sites/records collapses to one
 * signature: `#user-42` → `#id`, a uuid → `:uuid`, `[data-testid="row-7"]` →
 * `[data-testid]`, bare digit runs → `:n`. Used by §2 promotion (site-agnostic
 * recovery signature) and §3.2 fingerprint normalization (selector in a title).
 */
export function generalizeSubject(subject: string): string {
  return subject
    .replace(/\[data-testid=["'][^"']*["']\]/gi, "[data-testid]")
    .replace(/#[\w-]+/g, "#id")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ":uuid")
    .replace(/\d+/g, ":n");
}

export interface ExperienceInput {
  origin: string;
  scope: "site" | "global";
  kind: "fact" | "recovery" | "framework" | "timing";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  evidence: string[];
  runId: string;
  workedThisRun?: boolean; // recovery only
}

/**
 * Pure — selftested. The §1.2 upsert rule: run_count += 1 always; success_count only
 * for a working recovery; confidence takes the max — UNLESS a previously-trusted
 * recovery (≥70% success rate) just failed, which is the poison-guard contradiction
 * (confidence *= 0.5, contradicted_at stamped) rather than a silent climb in trust.
 */
export function mergeExperience(existing: ExperienceRow | null, input: ExperienceInput, now: number): Omit<ExperienceRow, "id"> {
  if (!existing) {
    return {
      origin: input.origin, scope: input.scope, kind: input.kind, subject: input.subject, predicate: input.predicate, object: input.object,
      confidence: input.confidence, source: input.source, evidence: JSON.stringify(input.evidence.slice(0, 10)),
      runCount: 1, successCount: input.kind === "recovery" ? (input.workedThisRun ? 1 : 0) : 1,
      lastRunId: input.runId, updatedAt: now, contradictedAt: null,
    };
  }
  let confidence = Math.max(existing.confidence, input.confidence);
  let successCount = existing.successCount;
  let contradictedAt = existing.contradictedAt;
  if (input.kind === "recovery") {
    if (input.workedThisRun) {
      successCount += 1;
    } else {
      const priorRate = existing.runCount > 0 ? existing.successCount / existing.runCount : 0;
      if (priorRate >= CONTRADICTION_TRUST_FLOOR) { confidence = existing.confidence * 0.5; contradictedAt = now; }
    }
  }
  const evidence = [...new Set([...(JSON.parse(existing.evidence) as string[]), ...input.evidence])].slice(0, 10);
  return {
    origin: existing.origin, scope: existing.scope, kind: existing.kind, subject: existing.subject, predicate: existing.predicate, object: existing.object,
    confidence, source: existing.source, evidence: JSON.stringify(evidence),
    runCount: existing.runCount + 1, successCount, lastRunId: input.runId, updatedAt: now, contradictedAt,
  };
}

/**
 * Pure — selftested. Poison-guard (§1.2): rows asserting a DIFFERENT object for the
 * same subject+predicate this run just contradicted are wrong (or stale) beliefs —
 * halve their confidence and stamp contradicted_at rather than leaving them to climb
 * in trust forever via run_count.
 */
export function contradictRows(conflicting: readonly ExperienceRow[], now: number): Omit<ExperienceRow, "id">[] {
  return conflicting.map((row) => ({ ...row, confidence: row.confidence * 0.5, contradictedAt: now }));
}

/**
 * Pure — selftested. §2 promotion: a recovery whose SITE-AGNOSTIC signature (subject
 * generalized, predicate+object untouched) recurs across ≥3 distinct origins with an
 * aggregate success rate ≥0.7 becomes a `scope='global'` row — knowledge that
 * transfers to a site never seen before.
 */
export function computeGlobalPromotions(siteRecoveryRows: readonly ExperienceRow[], now: number): Omit<ExperienceRow, "id">[] {
  const groups = new Map<string, ExperienceRow[]>();
  for (const row of siteRecoveryRows) {
    const sig = `${generalizeSubject(row.subject)}\u0000${row.predicate}\u0000${row.object}`;
    const g = groups.get(sig);
    if (g) g.push(row); else groups.set(sig, [row]);
  }
  const out: Omit<ExperienceRow, "id">[] = [];
  for (const [sig, rows] of groups) {
    const origins = new Set(rows.map((r) => r.origin));
    if (origins.size < PROMOTION_MIN_ORIGINS) continue;
    const runCount = rows.reduce((s, r) => s + r.runCount, 0);
    const successCount = rows.reduce((s, r) => s + r.successCount, 0);
    const rate = runCount > 0 ? successCount / runCount : 0;
    if (rate < PROMOTION_MIN_RATE) continue;
    const [subject, predicate, object] = sig.split("\u0000");
    const latestRunId = rows.reduce((latest, r) => (r.updatedAt > latest.updatedAt ? r : latest)).lastRunId;
    out.push({
      origin: "", scope: "global", kind: "recovery", subject, predicate, object,
      confidence: rate, source: "inferred", evidence: JSON.stringify([`promoted from ${origins.size} origins`]),
      runCount, successCount, lastRunId: latestRunId, updatedAt: now, contradictedAt: null,
    });
  }
  return out;
}

/** Pure — selftested. Seeds a fresh FactStore from recalled experience — the §3.5
 * safe-probing gate then skips re-probing what's already known. Below the confidence
 * floor a row is a live contradiction candidate, not a fact — skip it so probing
 * re-opens for it next run. Returns how many rows were seeded. */
export function recallFacts(facts: FactStore, rows: readonly ExperienceRow[]): number {
  let seeded = 0;
  for (const r of rows) {
    if (r.kind !== "fact" || r.confidence < RECALL_CONFIDENCE_FLOOR) continue;
    facts.assert({ subject: r.subject, predicate: r.predicate, object: r.object, confidence: r.confidence, source: r.source as FactSource, evidence: JSON.parse(r.evidence) as string[] });
    seeded++;
  }
  return seeded;
}

/** Pure — selftested. Compact "known from N previous runs" block for the planner
 * prompt (§1.3) — only rows worth mentioning (seen ≥2 runs or already high-confidence). */
export function summarizeForPrompt(rows: readonly ExperienceRow[]): string | null {
  const notable = rows.filter((r) => r.runCount >= 2 || r.confidence >= 0.8);
  if (!notable.length) return null;
  const lines = notable.slice(0, 40).map((r) => {
    if (r.kind === "recovery") return `- recovery '${r.object}' worked ${r.successCount}/${r.runCount} on ${r.subject}`;
    if (r.kind === "framework") return `- ${r.predicate}=${r.object}`;
    return `- ${r.subject} ${r.predicate} ${r.object} (confidence ${r.confidence.toFixed(2)}, seen ${r.runCount}x)`;
  });
  return `Known from ${notable.length} previous observation(s):\n${lines.join("\n")}`;
}

/** Pure — selftested. Recovery recall (§1.3): a strategy that's worked ≥70% of the
 * time over ≥2 runs for this exact failure signature — the point where an AI-based
 * (or any) recovery-reasoning consumer skips straight to executing it. */
export function recallRecoveryStrategy(rows: readonly ExperienceRow[], subject: string): { strategy: string; successRate: number } | null {
  const best = rows
    .filter((r) => r.kind === "recovery" && r.subject === subject && r.runCount >= 2)
    .map((r) => ({ strategy: r.object, successRate: r.successCount / r.runCount }))
    .filter((c) => c.successRate >= CONTRADICTION_TRUST_FLOOR)
    .sort((a, b) => b.successRate - a.successRate)[0];
  return best ?? null;
}

// ---- db.ts wiring (impure) --------------------------------------------------

function upsertExperience(input: ExperienceInput): void {
  const now = Date.now();
  const existing = getExperienceRow(input.origin, input.kind, input.subject, input.predicate, input.object);
  putExperienceRow(mergeExperience(existing, input, now));
}

/**
 * Called once at the end of a run (orchestrate.ts, where RunReport is finalized).
 * Dumps this run's FactStore (confidence ≥ 0.6), recovery outcomes, and the
 * detected site profile into the experience table, then decays stale rows and
 * re-runs the §2 global-pattern promotion.
 */
export function saveExperience(ctx: RunContext, origin: string): void {
  const runId = ctx.runId;
  const now = Date.now();

  for (const f of ctx.facts.all()) {
    if (f.confidence < MIN_FACT_CONFIDENCE) continue;
    const conflicting = listConflictingFactRows(origin, f.subject, f.predicate, f.object);
    for (const row of contradictRows(conflicting, now)) putExperienceRow(row);
    upsertExperience({ origin, scope: "site", kind: "fact", subject: f.subject, predicate: f.predicate, object: f.object,
      confidence: f.confidence, source: f.source, evidence: f.evidence, runId });
  }

  for (const r of ctx.recoveriesUsed) {
    upsertExperience({ origin, scope: "site", kind: "recovery", subject: r.subject, predicate: "recovery", object: r.strategy,
      confidence: 0.7, source: "observed", evidence: [`run ${runId}: ${r.worked ? "worked" : "failed"}`], runId, workedThisRun: r.worked });
  }

  if (ctx.siteProfile) {
    const sig = ctx.siteProfile.signals;
    if (ctx.siteProfile.framework) {
      upsertExperience({ origin, scope: "site", kind: "framework", subject: origin, predicate: "framework", object: ctx.siteProfile.framework,
        confidence: 0.9, source: "observed", evidence: sig, runId });
    }
    upsertExperience({ origin, scope: "site", kind: "framework", subject: origin, predicate: "site-kind", object: ctx.siteProfile.kind,
      confidence: 0.9, source: "observed", evidence: sig, runId });
  }

  pruneStaleExperience(origin, now - DECAY_MS);
  for (const row of computeGlobalPromotions(listSiteRecoveryRows(), now)) putExperienceRow(row);
}

/** Site rows for `origin` + all global rows, highest run_count first, capped at 200 (§1.2). */
export function loadExperience(origin: string): ExperienceRow[] {
  return listExperienceForOrigin(origin, RECALL_CAP);
}
