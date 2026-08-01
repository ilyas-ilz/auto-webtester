import type { BrowserContext, Page } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";
import { probePage } from "../probeDriver";
import type { ProbePlanItem } from "../probe";
import { learnLifecycle, lifecycleViolations, type Transition } from "../lifecycle";
import type { ObservationQuality } from "../recovery";
import { freezeContract, checkContract, type ContractKind, type Observation } from "../contracts";
import { getContract, saveContract, saveTransitions, listTransitions } from "../../db";
import { looksLoggedOut } from "./login";

const AGENT = "learning";
const MAX_PAGES = 6; // ponytail: bound the mutating probe sweep; probing clicks real controls

/**
 * Application-Intelligence consumer (Plan-v7 §3.3–§3.6, wave 2). The pure cores
 * (probe/facts/lifecycle) land ahead of their consumer by design — this is that consumer.
 * On a small sample of pages it runs the §3.5 safe-probe loop (learning §3.4 facts about
 * what each control does, so later encounters skip the AI call) and watches for §3.3
 * lifecycle transitions the probing causes, flagging impossible ones. Every unknown it
 * meets is counted into the §6 ARR tally.
 *
 * SAFETY: probing mutates (it clicks controls), so — like crud — it is off-production and
 * only ever acts when a disposable qabot- entity exists to absorb the mutation. The
 * per-control safety gate lives in probe.ts and still governs everything here.
 */
export async function learningAgent(
  ctx: RunContext,
  browserCtx: BrowserContext,
  project: Project,
  role: RoleCred,
  sampleSize: number,
): Promise<void> {
  if (project.envTag === "production") {
    ctx.log(AGENT, "warn", "Learning/probe agent skipped on production (safety) — probing mutates; point it at localhost/staging.");
    return;
  }
  // A disposable entity this run created (crud captured its write) is what makes a
  // MUTATING probe safe. Without one, only read-only controls are probeable (the gate
  // enforces this per-control regardless).
  const disposableEntityExists = ctx.idorWrites.length > 0;

  const pages = ctx.sampleFor(role.name, Math.min(sampleSize, MAX_PAGES), AGENT);
  const transitions: Transition[] = [];
  let learnedCount = 0;

  for (const p of pages) {
    const page = await browserCtx.newPage();
    try {
      await ctx.observe(page, p.url, AGENT);
      const subject = ctx.pageTypes.get(p.url) ?? new URL(p.url).pathname;
      ctx.status(AGENT, `Probing unknown controls on ${p.url} as ${role.name}`, { url: p.url });

      const before = await readStatusTokens(page);
      const { learned, plan, preKnown } = await probePage(ctx.facts, subject, page, {
        disposableEntityExists,
        onTestPath: () => true, // every sampled page IS the path we're testing
        knows: (s, pred) => ctx.facts.knows(s, pred),
      });
      const after = await readStatusTokens(page);

      learnedCount += learned.length;
      const learnedActions = new Set(learned.map((f) => f.predicate.replace(/^effect-of:/, "")));
      const tally = accountArr(plan, preKnown, learnedActions);
      ctx.arr.encountered += tally.encountered;
      ctx.arr.byFacts += tally.byFacts;
      ctx.arr.byProbe += tally.byProbe;
      ctx.arr.requiredAI += tally.requiredAI;
      ctx.arr.unresolved += tally.unresolved;

      // §3.3: if the probe pass moved the entity between two recognized statuses, that's
      // an observed lifecycle transition. Reads are stable, so grade it clean.
      const tr = statusTransition(before, after);
      if (tr) transitions.push({ entityType: subject, action: "(probed)", from: tr.from, to: tr.to, actorRole: role.name, quality: "clean" });
    } catch (e) {
      ctx.log(AGENT, "warn", `Probe pass on ${p.url} failed: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  // §3.3: judge this run's transitions against a model learned from PRIOR runs' known-good
  // history — that's what lets backward/wrong-role fire (a single run's own model would
  // contain the offending edge and mask it; post-terminal is model-free and fires anyway).
  const prior = listTransitions(ctx.projectId).map((t) => ({ ...t, quality: "clean" as ObservationQuality }));
  const model = learnLifecycle(prior);
  const violations = lifecycleViolations(model, transitions);
  const flagged = new Set(violations.map((v) => transitionKey(v.transition)));
  for (const v of violations) {
    ctx.finding({
      agent: AGENT,
      severity: v.kind === "post-terminal" ? "high" : "medium",
      role: role.name,
      pageUrl: null,
      title: `Suspicious ${v.kind} transition on ${v.transition.entityType}`,
      detail: v.detail,
      evidence: null,
    });
  }
  // Grow the known-good history for next run — but never persist a transition we just
  // flagged as a bug, or it becomes "normal" and self-silences on the next run.
  const good = transitions.filter((t) => t.quality === "clean" && !flagged.has(transitionKey(t)));
  if (good.length) saveTransitions(ctx.projectId, good);

  const rate = ctx.arr.encountered ? Math.round(((ctx.arr.byFacts + ctx.arr.byProbe) / ctx.arr.encountered) * 100) : 0;
  ctx.log(AGENT, "pass", `Learned ${learnedCount} fact(s) across ${pages.length} page(s); ARR ${rate}% (${ctx.arr.byProbe} probed, ${ctx.arr.byFacts} known, ${ctx.arr.requiredAI} would need AI)`);
}

/**
 * §3.7 session-persists contract: an authenticated session must survive a page reload.
 * Login proves you CAN authenticate; nothing else proves it STICKS. First clean run
 * freezes the invariant; a later run where the session silently drops on reload fails it
 * — an auth/session regression. Read-only (navigate + reload), safe on any environment.
 */
export async function sessionPersistsContract(
  ctx: RunContext,
  browserCtx: BrowserContext,
  project: Project,
  role: RoleCred,
  startUrl: string,
): Promise<void> {
  const page = await browserCtx.newPage();
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    const obs: Observation = { kind: "session-persists", subject: role.name, holds: !(await looksLoggedOut(page, project)), quality: "clean" };
    const frozen = getContract(project.id, "session-persists", role.name);
    if (!frozen) {
      const c = freezeContract(obs);
      if (c) { saveContract(project.id, c); ctx.log(AGENT, "step", `Froze contract: ${role.name} session persists across reload`); }
    } else if (checkContract({ kind: frozen.kind as ContractKind, subject: frozen.subject, expected: frozen.expected }, obs) === "fail") {
      ctx.finding({
        agent: AGENT, severity: "high", kind: "bug", role: role.name, pageUrl: startUrl,
        title: `Session no longer persists across reload for ${role.name}`,
        detail: `${role.name} was logged out after a reload, but an earlier run froze this session as persistent (§3.7 contract) — an auth/session regression, not a first-time observation.`,
        evidence: null,
      });
    }
  } catch (e) {
    ctx.log(AGENT, "warn", `session-persists check failed for ${role.name}: ${String(e).slice(0, 160)}`);
  } finally {
    await page.close();
  }
}

// ---- pure helpers (selftested) ---------------------------------------------

export interface ArrTally {
  encountered: number;
  byFacts: number;
  byProbe: number;
  requiredAI: number;
  unresolved: number;
}

/**
 * ARR accounting for one page's probe plan (§6). Order matters: an already-known action
 * is `byFacts` even though the gate also declined to probe it. A greenlit item that
 * learned a fact is `byProbe`; one that was greenlit but learned nothing was too unstable
 * to trust (`unresolved`); an item the gate refused (unknown + unsafe) is the AI-escalation
 * target (`requiredAI`).
 */
export function accountArr(plan: readonly ProbePlanItem[], preKnown: ReadonlySet<string>, learned: ReadonlySet<string>): ArrTally {
  const t: ArrTally = { encountered: 0, byFacts: 0, byProbe: 0, requiredAI: 0, unresolved: 0 };
  for (const item of plan) {
    t.encountered++;
    if (preKnown.has(item.action)) t.byFacts++;
    else if (learned.has(item.action)) t.byProbe++;
    else if (item.decision) t.unresolved++;
    else t.requiredAI++;
  }
  return t;
}

// Status words we trust as lifecycle states — deliberately closed so arbitrary badge text
// (counts, categories, "new message") isn't mistaken for a status. Extend as real apps demand.
const STATUS_VOCAB = /^(draft|published|pending|approved|rejected|active|inactive|archived|deleted|cancell?ed|paid|unpaid|open|closed|complete[d]?|hired|applied|shipped|refunded|voided?|enabled|disabled|expired|suspended|banned|verified|unverified|processing|failed|success|new|done)$/i;

/**
 * A single clean lifecycle transition from status tokens seen before/after a mutating
 * pass: exactly one recognized status left and one arrived. Ambiguous multi-swaps return
 * null — §3.6's "don't learn from an unstable observation" applied to status reading.
 */
/** Stable identity of a transition — dedupes persistence and marks which ones were flagged. */
export function transitionKey(t: Pick<Transition, "entityType" | "action" | "from" | "to" | "actorRole">): string {
  return `${t.entityType}|${t.action}|${t.from}>${t.to}|${t.actorRole}`;
}

export function statusTransition(before: readonly string[], after: readonly string[]): { from: string; to: string } | null {
  const keep = (xs: readonly string[]): string[] => xs.map((s) => s.trim()).filter((s) => STATUS_VOCAB.test(s));
  const b = new Set(keep(before));
  const a = new Set(keep(after));
  const gone = [...b].filter((s) => !a.has(s));
  const came = [...a].filter((s) => !b.has(s));
  return gone.length === 1 && came.length === 1 ? { from: gone[0], to: came[0] } : null;
}

async function readStatusTokens(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("[data-status],[data-state],.status,.badge,.state,.chip").forEach((e) => {
        const t = (e.textContent || "").trim();
        if (t && t.length <= 30) out.push(t);
      });
      return out;
    })
    .catch(() => [] as string[]);
}
