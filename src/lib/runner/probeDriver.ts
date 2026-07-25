import type { Page, Response } from "playwright";
import { semanticSnapshot, canonicalStateKey } from "./snapshot";
import { classifyObservation } from "./recovery";
import type { FactStore, Fact } from "./facts";
import { planProbes, runProbePlan, type ProbeIO, type ProbePlanItem, type ProbeTarget } from "./probe";

/**
 * Live browser side of the §3.5 probe-executor. The decision layer and the learn step are
 * pure and selftested in probe.ts; this file is the thin Playwright edge — exercised by
 * real runs, not selftest (like snapshot.ts's in-page collector). It does exactly the I/O
 * the pure loop can't: read the current state key, click a control, watch the request it
 * fires, and grade the observation's quality (§3.6).
 */

type Role = Parameters<Page["getByRole"]>[0];

/** Real Playwright `ProbeIO`: snapshot→key, and a click that yields quality + the mutating status. */
export function browserProbeIO(page: Page): ProbeIO {
  return {
    async stateKey(): Promise<string> {
      return canonicalStateKey(await semanticSnapshot(page));
    },
    async perform(item: ProbePlanItem): Promise<{ quality: import("./recovery").ObservationQuality; apiStatus: number | null }> {
      // Grab the first mutating request the click triggers (GET/HEAD are reads, ignore).
      let apiStatus: number | null = null;
      const onResp = (resp: Response): void => {
        const m = resp.request().method().toUpperCase();
        if (apiStatus == null && m !== "GET" && m !== "HEAD") apiStatus = resp.status();
      };
      page.on("response", onResp);
      let succeeded = false;
      try {
        await page.getByRole(item.role as Role, { name: item.name }).first().click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        succeeded = true; // the before/after state keys the loop compares ARE the verification
      } catch {
        succeeded = false; // couldn't perform it → "failed" observation → learns nothing
      } finally {
        page.off("response", onResp);
      }
      const quality = classifyObservation({ succeeded, attempts: 1, recoveredVia: null, stateVerified: succeeded });
      return { quality, apiStatus };
    },
  };
}

/**
 * Snapshot the page, plan probes over its interactive controls, and run the greenlit ones.
 * `subject` is what the controls act on (entity type / page); `opts` carries the live gate
 * inputs (does a disposable qabot- entity exist, is the control on the test path, is the
 * effect already a known fact). Returns the facts learned this pass.
 */
export async function probePage(
  facts: FactStore,
  subject: string,
  page: Page,
  opts: { disposableEntityExists: boolean; onTestPath: (t: ProbeTarget) => boolean; knows: (subject: string, predicate: string) => boolean },
): Promise<{ learned: Fact[]; plan: ProbePlanItem[]; preKnown: Set<string> }> {
  const snap = await semanticSnapshot(page);
  const controls: ProbeTarget[] = snap.nodes
    .filter((n) => n.interactive && n.name && n.visible)
    .map((n) => ({ ref: n.ref, role: n.role, name: n.name }));
  // Snapshot what we already knew BEFORE probing mutates the store — ARR needs to tell
  // "resolved from an existing fact" apart from "resolved by probing now" (§6).
  const preKnown = new Set(controls.filter((c) => c.name && opts.knows(subject, `effect-of:${c.name}`)).map((c) => c.name));
  const plan = planProbes(subject, controls, opts);
  const learned = await runProbePlan(facts, subject, plan, browserProbeIO(page));
  return { learned, plan, preKnown };
}
