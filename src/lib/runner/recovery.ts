import type { RunContext } from "./context";
import { RunCancelledError, waitForHuman } from "./control";

// Resilience wrapper (Plan-v2 §3.5). Senior testers don't quit on the first
// error; neither does the runner. Runs an agent, retries once on throw, then
// reports-and-continues (returns null) instead of aborting the whole role.
// ponytail: retry-once + continue covers transient nav/timeout flakes. Add
// reload / re-auth / selector-fallback rungs here if real flakiness demands it.
export async function withRecovery<T>(
  ctx: Pick<RunContext, "log" | "agentsRan" | "agentsFailed" | "findingCounts" | "checkCancelled" | "runId" | "skipCompleted">,
  agent: string,
  fn: () => Promise<T>
): Promise<T | null> {
  ctx.checkCancelled(); // one gate before every agent — a stopped run doesn't start the next one
  // Resume: this step already finished in the run this one picks up from. Must be
  // asked on EVERY step (skipped or not) — it counts positions to stay in lockstep.
  if (ctx.skipCompleted(agent)) {
    ctx.agentsRan.add(agent);
    ctx.log(agent, "agent-done", `${agent} skipped — already completed in the interrupted run`, { durationMs: 0, findings: 0, failed: false, resumed: true });
    return null;
  }
  // Same gate for the human at the wheel: they took control of the live view, so
  // no agent starts navigating the page out from under them until they let go.
  await waitForHuman(
    ctx.runId,
    () => ctx.log(agent, "warn", `Waiting — a human is driving the live view`),
    () => ctx.checkCancelled(),
  );
  ctx.agentsRan.add(agent);
  const startedAt = Date.now();
  const findingsBefore = ctx.findingCounts.get(agent) ?? 0;
  ctx.log(agent, "agent-start", `${agent} started`);
  const done = (failed: boolean): void => {
    const durationMs = Date.now() - startedAt;
    const findings = (ctx.findingCounts.get(agent) ?? 0) - findingsBefore;
    ctx.log(agent, "agent-done", `${agent} ${failed ? "failed" : "finished"}`, { durationMs, findings, failed });
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fn();
      done(false);
      return result;
    } catch (e) {
      // Stop is not a flake — never retry it, and let it unwind the whole run.
      if (e instanceof RunCancelledError) { done(true); throw e; }
      const last = attempt === 2;
      ctx.log(agent, "warn", `${last ? "failed after retry" : "errored, retrying"}: ${String(e).slice(0, 160)}`);
      if (last) {
        // P0-2: a twice-failed agent is recorded, not forgotten — the verdict
        // engine downgrades the run to inconclusive instead of a silent PASS.
        ctx.agentsFailed.set(agent, String(e).slice(0, 200));
        done(true);
        return null;
      }
    }
  }
  return null;
}

// --- Observation quality (Plan-v7 §3.6) -----------------------------------
//
// withRecovery keeps a role ALIVE through flakes. §3.6 answers a different
// question: after we recover, how much do we TRUST what we saw? The learning
// layer (graph_nodes) must never learn from unstable execution — a finding
// observed only after a reload+re-auth dance is not the same evidence as one
// seen on a clean first try. So every observation carries a quality flag, and
// only trustworthy ones feed the moat.

export type ObservationQuality = "clean" | "recovered" | "ambiguous" | "failed";

/** Raw execution facts, produced by `observe`. Pure input to the classifier. */
export interface ExecFacts {
  succeeded: boolean; // did the action ultimately return a result?
  attempts: number; // total tries, 1 = succeeded first try
  recoveredVia: string | null; // name of the recovery rung that fixed it, null if none was needed
  stateVerified: boolean; // could we deterministically confirm the post-action state?
}

/**
 * Map execution facts to a trust level:
 *  - failed:    never produced a result.
 *  - ambiguous: produced a result we CAN'T confirm (verify failed) — succeeded ≠ trustworthy.
 *  - recovered: succeeded and confirmed, but only after a retry/recovery rung.
 *  - clean:     succeeded and confirmed on the first try, no recovery.
 * Order matters: an unverifiable success is ambiguous even if it also "recovered".
 */
export function classifyObservation(f: ExecFacts): ObservationQuality {
  if (!f.succeeded) return "failed";
  if (!f.stateVerified) return "ambiguous";
  if (f.attempts > 1 || f.recoveredVia) return "recovered";
  return "clean";
}

/** The learning gate: only clean/recovered observations may update the project graph. */
export function isTrustworthy(q: ObservationQuality): boolean {
  return q === "clean" || q === "recovered";
}

/** One deterministic remediation (reload, wait-for-idle, re-auth, dismiss-overlay…). */
export interface RecoveryStep {
  name: string;
  apply: () => Promise<void>;
}

export interface Observation<T> {
  result: T | null;
  quality: ObservationQuality;
  attempts: number;
  recoveredVia: string | null;
}

/**
 * Run an action through a deterministic recovery tree, then classify the result.
 *
 * The "tree" is `ladder`: ordered rungs tried IN ORDER between retries — no AI,
 * fully deterministic. Rung −1 is the clean first attempt; each subsequent rung
 * runs its `apply` (the remediation) and re-runs the action. A rung whose own
 * `apply` throws is skipped to the next. `verify` confirms the post-action state;
 * if it returns false the observation is `ambiguous` even on success, because we
 * won't learn from a state we can't trust.
 *
 * Page-agnostic on purpose (steps are injected), so it selftests without a browser.
 */
export async function observe<T>(
  action: () => Promise<T>,
  opts: { ladder?: RecoveryStep[]; verify?: (r: T) => boolean | Promise<boolean> } = {},
): Promise<Observation<T>> {
  const ladder = opts.ladder ?? [];
  let attempts = 0;
  let recoveredVia: string | null = null;
  for (let rung = -1; rung < ladder.length; rung++) {
    if (rung >= 0) {
      try {
        await ladder[rung].apply();
      } catch {
        continue; // remediation itself failed — try the next rung, don't count it as an attempt
      }
      recoveredVia = ladder[rung].name;
    }
    attempts++;
    try {
      const result = await action();
      const stateVerified = opts.verify ? await opts.verify(result) : true;
      return { result, quality: classifyObservation({ succeeded: true, attempts, recoveredVia, stateVerified }), attempts, recoveredVia };
    } catch {
      // action still failing — fall through to the next recovery rung
    }
  }
  return { result: null, quality: "failed", attempts, recoveredVia };
}
