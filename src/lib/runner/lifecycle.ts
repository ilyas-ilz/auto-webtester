import { isTrustworthy, type ObservationQuality } from "./recovery";

/**
 * Entity-lifecycle learning (Plan-v7 §3.3) — where business-logic testing begins.
 *
 * We observe status transitions on business entities ("Applied"→"Hired",
 * "Draft"→"Published") and LEARN the normal direction, then flag transitions that
 * contradict what we've seen or resurrect a terminal state. No domain knowledge is
 * hard-coded — direction is learned from observation; the one universal rule is that
 * a terminal state (deleted/cancelled/…) shouldn't flow back to an active one.
 *
 * §3.6 interlock: only trustworthy observations (clean/recovered) are learned from or
 * judged. A transition seen only through a flaky, recovered-after-a-modal execution is
 * not evidence of a real lifecycle edge — never learn from unstable execution.
 *
 * This is the deterministic core (pure, selftested). Recording transitions to the
 * graph and emitting findings is the consumer's job (a status-observing agent), wired
 * when one exists — the brain lands ahead of it, like snapshot.ts.
 */

export interface Transition {
  entityType: string; // the KIND of thing ("application", "invoice"), not the instance id
  action: string; // the control/label that caused it ("Hire", "Publish")
  from: string; // status before
  to: string; // status after
  actorRole: string; // who performed it
  quality: ObservationQuality; // execution quality of the observation (§3.6)
}

export type ViolationKind = "post-terminal" | "backward" | "wrong-role";

export interface Violation {
  kind: ViolationKind;
  transition: Transition;
  detail: string;
}

export interface LearnedModel {
  edges: Set<string>; // "type|action|from>to" seen at least once (trustworthy only)
  actorsByAction: Map<string, Set<string>>; // "type|action" → roles observed performing it
}

// A status is terminal if its name reads as end-of-life. Reactivating one
// (terminal → active) is the single domain-free red flag worth hard-coding.
const TERMINAL = /(deleted|removed|cancell?ed|archived|voided?|refunded|closed|expired)/i;

const norm = (s: string): string => s.trim().toLowerCase();

/** Build the learned model from trustworthy observations only (§3.6 interlock). */
export function learnLifecycle(transitions: Transition[]): LearnedModel {
  const edges = new Set<string>();
  const actorsByAction = new Map<string, Set<string>>();
  for (const t of transitions) {
    if (!isTrustworthy(t.quality)) continue;
    edges.add(`${t.entityType}|${norm(t.action)}|${norm(t.from)}>${norm(t.to)}`);
    const ak = `${t.entityType}|${norm(t.action)}`;
    let set = actorsByAction.get(ak);
    if (!set) { set = new Set(); actorsByAction.set(ak, set); }
    set.add(t.actorRole);
  }
  return { edges, actorsByAction };
}

/**
 * Flag suspicious transitions against a learned model (built from prior/known-good
 * history):
 *  - post-terminal: from a terminal status to a non-terminal one (Deleted→Active).
 *  - backward: the reverse edge (to→from) was learned but this from→to was not — we
 *    saw Applied→Hired, now Hired→Applied.
 *  - wrong-role: an actor performs an action only ever seen performed by other roles.
 * Only trustworthy transitions are judged — a flaky execution isn't a lifecycle bug.
 */
export function lifecycleViolations(model: LearnedModel, transitions: Transition[]): Violation[] {
  const out: Violation[] = [];
  for (const t of transitions) {
    if (!isTrustworthy(t.quality)) continue;
    const from = norm(t.from), to = norm(t.to);
    if (from === to) continue;
    const action = norm(t.action);
    const fwd = `${t.entityType}|${action}|${from}>${to}`;
    const rev = `${t.entityType}|${action}|${to}>${from}`;

    if (TERMINAL.test(from) && !TERMINAL.test(to)) {
      out.push({ kind: "post-terminal", transition: t, detail: `"${t.from}" is a terminal state; transitioning it to "${t.to}" resurrects a finished entity.` });
      continue;
    }
    if (model.edges.has(rev) && !model.edges.has(fwd)) {
      out.push({ kind: "backward", transition: t, detail: `Saw "${t.from}"→"${t.to}" but the normal direction was "${t.to}"→"${t.from}" — a backward transition.` });
      continue;
    }
    const actors = model.actorsByAction.get(`${t.entityType}|${action}`);
    if (actors && actors.size > 0 && !actors.has(t.actorRole)) {
      out.push({ kind: "wrong-role", transition: t, detail: `Role "${t.actorRole}" performed "${t.action}" on ${t.entityType}, only ever seen done by: ${[...actors].join(", ")}.` });
    }
  }
  return out;
}
