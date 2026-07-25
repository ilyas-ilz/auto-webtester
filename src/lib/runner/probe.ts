/**
 * Safe active probing gate (Plan-v7 §3.5) — the biggest real AI-cost cut.
 *
 * Today: observe → test → report. Add: observe → uncertainty → safe reversible probe →
 * learn → test. When an action's effect is unknown (a bare "Archive" button), don't
 * immediately call AI: experiment on a disposable entity, observe the delta, infer the
 * fact. AI becomes the second-to-last resort, not the first.
 *
 * The gate is deliberately BOOLEAN, not GPT's `infoGain×relevance×riskImportance×
 * reversibility − cost − mutationRisk` (invented weights on unmeasurable terms). A
 * boolean gate already stops "probe everything"; add a numeric score only if it
 * measurably over/under-probes.
 *
 * Safety: a probe that mutates is disposable-entity-only and off-production — that
 * guard lives in crud.ts and still applies to anything this gate greenlights.
 */

export interface ProbeContext {
  onTestPath: boolean; // is this unknown on the path we're already testing? ("Archive" here vs "Help Center")
  disposableEntityExists: boolean; // do we have a qabot- entity to safely experiment on?
  readOnly: boolean; // is the action non-mutating (safe to probe regardless)?
  alreadyLearned: boolean; // is the effect already a known fact? (FactStore.knows)
}

/** Probe only if it's on-path, safe (disposable entity OR read-only), and not already known. */
export function shouldProbe(c: ProbeContext): boolean {
  if (!c.onTestPath) return false;
  if (c.alreadyLearned) return false;
  return c.readOnly || c.disposableEntityExists;
}

import { isTrustworthy, type ObservationQuality } from "./recovery";
import type { Fact, FactStore } from "./facts";

export type Strategy = "use-known" | "probe" | "infer" | "ai" | "record-unknown";

/**
 * The escalation ladder (§3.5): known? → use it; else safe-probe? → experiment; else a
 * code/network/history signal? → infer; else AI (if available); else record the unknown.
 * Deterministic order — the whole point is that AI is near the bottom.
 */
export function resolveStrategy(c: ProbeContext & { known: boolean; hasCodeSignal: boolean; aiAvailable: boolean }): Strategy {
  if (c.known) return "use-known";
  if (shouldProbe(c)) return "probe";
  if (c.hasCodeSignal) return "infer";
  if (c.aiAvailable) return "ai";
  return "record-unknown";
}

// ---- probe-executor loop (§3.5): observe → probe → LEARN a fact -------------
//
// The gate above decides WHETHER to probe. This is what happens when it says yes:
// snapshot state, perform the reversible action, snapshot again, and turn the delta
// into a `Fact` the store remembers — so the next encounter hits "use-known" and never
// re-probes or calls AI. The effect-derivation is pure (selftested without a browser);
// the browser side just supplies before/after state keys and the observation quality.

export interface ProbeOutcome {
  action: string; // the control we probed ("Archive")
  subject: string; // what it acts on (entity type / page), the fact's subject
  stateKeyBefore: string; // canonicalStateKey before the action
  stateKeyAfter: string; // canonicalStateKey after (+ any refresh) — same key ⇒ no visible state change
  apiStatus: number | null; // status of the mutating request it fired, if one was seen
  quality: ObservationQuality; // §3.6 — only trustworthy observations may mint a fact
}

/**
 * Turn a probe outcome into the fact we now believe about the action's effect.
 * Deterministic, so it's `source: "probed"` at high confidence — direct evidence
 * outranks inference and AI in the FactStore. Returns null when the observation is too
 * unstable to learn from (§3.6): we probed, but we don't record a lie.
 */
export function factFromProbe(o: ProbeOutcome): Fact | null {
  if (!isTrustworthy(o.quality)) return null; // never learn from an unstable execution
  const changed = o.stateKeyBefore !== o.stateKeyAfter;
  const apiOk = o.apiStatus != null && o.apiStatus >= 200 && o.apiStatus < 300;
  const effect = changed
    ? "mutates-state"
    : apiOk
      ? "server-effect-only" // API accepted it but the visible state is unchanged (background/async, or a no-op)
      : "no-effect";
  // `clean` first-try evidence is stronger than a `recovered`-after-retry one.
  const confidence = o.quality === "clean" ? 0.9 : 0.7;
  const evidence = [
    `probe ${o.action}: state ${o.stateKeyBefore}→${o.stateKeyAfter}`,
    o.apiStatus != null ? `api HTTP ${o.apiStatus}` : "no request observed",
    `observation ${o.quality}`,
  ];
  return { subject: o.subject, predicate: `effect-of:${o.action}`, object: effect, evidence, confidence, source: "probed" };
}

/**
 * The loop's learn step: derive the fact and assert it into the store. Returns the fact
 * (for logging/findings) or null if the observation wasn't trustworthy. Idempotent — a
 * repeat probe of the same action asserts the same triple, which the store dedupes.
 */
export function learnFromProbe(facts: FactStore, o: ProbeOutcome): Fact | null {
  const f = factFromProbe(o);
  if (f) facts.assert(f);
  return f;
}

// ---- driver decision layer (§3.5): turn a live page's controls into a probe plan ----
//
// The browser side (probeDriver.ts) supplies the snapshot and does the clicking. This is
// the pure brain between them: from the interactive controls on a page, decide WHICH to
// probe and whether each is safe — reusing the same `shouldProbe` gate, so the driver
// can't probe anything the gate would reject. Selftested without a browser.

export type ControlRisk = "read-only" | "mutating" | "unknown";

// A control's likely effect, read from its accessible name (verb) then role. "mutating"
// needs a disposable entity to probe safely; "read-only" is free; a bare unmatched button
// is "unknown" and treated as mutating for safety (never probed without a disposable target).
const MUTATING_NAME = /\b(delete|remove|archive|save|submit|create|add|update|edit|publish|unpublish|approve|reject|send|pay|cancel|disable|enable|reset|revoke|deactivate|activate|confirm|apply|upload)\b/i;
const READONLY_NAME = /\b(view|open|show|details?|help|about|search|filter|sort|next|prev|previous|back|home|profile|settings|expand|collapse|read more|learn more|close|menu)\b/i;

export function classifyControl(role: string, name: string): ControlRisk {
  if (MUTATING_NAME.test(name)) return "mutating";
  if (READONLY_NAME.test(name)) return "read-only";
  if (role === "link") return "read-only"; // a plain navigation link with no mutating verb
  return "unknown";
}

export interface ProbeTarget {
  ref: string; // relocation hint from the snapshot (for logging / the driver)
  role: string;
  name: string;
}

export interface ProbePlanItem extends ProbeTarget {
  action: string; // the accessible name, used as the fact's action key
  risk: ControlRisk;
  decision: boolean; // did the §3.5 gate greenlight probing this control?
}

/**
 * Build the probe plan for one page's controls. One entry per DISTINCT action (dedup by
 * name), each carrying the gate's yes/no so the driver only acts on greenlit items and a
 * test can assert the whole decision. `onTestPath`/`knows`/`disposableEntityExists` are
 * the same inputs `shouldProbe` needs, supplied by the caller from live context.
 */
export function planProbes(
  subject: string,
  controls: readonly ProbeTarget[],
  opts: { disposableEntityExists: boolean; onTestPath: (t: ProbeTarget) => boolean; knows: (subject: string, predicate: string) => boolean },
): ProbePlanItem[] {
  const seen = new Set<string>();
  const plan: ProbePlanItem[] = [];
  for (const c of controls) {
    if (!c.name || seen.has(c.name)) continue; // skip nameless controls and repeat actions
    seen.add(c.name);
    const risk = classifyControl(c.role, c.name);
    const decision = shouldProbe({
      onTestPath: opts.onTestPath(c),
      disposableEntityExists: opts.disposableEntityExists,
      readOnly: risk === "read-only",
      alreadyLearned: opts.knows(subject, `effect-of:${c.name}`),
    });
    plan.push({ ...c, action: c.name, risk, decision });
  }
  return plan;
}

/**
 * The IO the driver needs from the browser — a factory in probeDriver.ts supplies the real
 * Playwright version; selftests pass a fake. `perform` does the click AND owns observation
 * quality (§3.6) and the mutating-request status, so all browser I/O lives behind it.
 */
export interface ProbeIO {
  stateKey(): Promise<string>; // canonicalStateKey of the current page
  perform(item: ProbePlanItem): Promise<{ quality: ObservationQuality; apiStatus: number | null }>;
}

/**
 * Execute a plan: for each greenlit item, snapshot → perform → snapshot → learn. Returns
 * the facts actually learned (trustworthy observations only; the rest are gated out inside
 * `learnFromProbe`). This is the full §3.5 loop, minus the browser, and is selftested with
 * a fake IO end-to-end.
 */
export async function runProbePlan(facts: FactStore, subject: string, plan: readonly ProbePlanItem[], io: ProbeIO): Promise<Fact[]> {
  const learned: Fact[] = [];
  for (const item of plan) {
    if (!item.decision) continue;
    const before = await io.stateKey();
    const { quality, apiStatus } = await io.perform(item);
    const after = await io.stateKey();
    const f = learnFromProbe(facts, { action: item.action, subject, stateKeyBefore: before, stateKeyAfter: after, apiStatus, quality });
    if (f) learned.push(f);
  }
  return learned;
}
