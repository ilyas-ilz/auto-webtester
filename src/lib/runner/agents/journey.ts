import type { BrowserContext, Page, Locator } from "playwright";
import type { Project, RoleCred, Journey, RunMode } from "../../types";
import { RunContext } from "../context";
import { aiAvailable, aiToolCall } from "../ai";
import { UNSAFE } from "./crawler";
import { crudTag } from "./crud";
import { expandEdgeTokens } from "../fuzz";

const AGENT = "journey";
const DEFAULT_MAX_ACTIONS = 30;
const PER_JOURNEY_TOKEN_CAP = 8000;
const DIGEST_CAP = 60;
const DESTRUCTIVE = /(delete|remove|destroy|\bpay\b|purchase|checkout|cancel subscription|deactivate|close account)/i;

/** Ordered target-resolution strategies (Plan-v4 P5.2 Executor). Exposed for selftest. */
export const RESOLVE_ORDER = ["role-button", "role-link", "label", "placeholder", "text-exact", "text-loose"] as const;

interface Session { role: RoleCred; browserCtx: BrowserContext }
export interface NavAction {
  action: "click" | "fill" | "select" | "press" | "goto" | "step_done" | "journey_done" | "stuck";
  target?: string;
  value?: string;
  why?: string;
}

const ACTION_TOOL = {
  name: "act",
  description: "Choose the single next action to progress the business flow. Use semantic targets, never CSS selectors.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["click", "fill", "select", "press", "goto", "step_done", "journey_done", "stuck"] },
      target: { type: "string", description: 'What to act on in plain words ("the Publish button", "the Title field") or a URL for goto.' },
      value: { type: "string", description: "Text to type / option to select / key to press." },
      why: { type: "string", description: "One short sentence of reasoning." },
    },
    required: ["action", "why"],
  },
};

/** Strip filler so "the Publish button" resolves as "Publish". Pure — selftested. */
export function stripTarget(target: string): string {
  return target.replace(/^the\s+/i, "").replace(/\s+(button|link|field|input|tab|menu item|option|icon)$/i, "").trim();
}

/** Format+cap the raw interactive-element list into the Navigator digest. Pure — selftested. */
export function buildDigest(raw: { role: string; name: string }[], cap: number = DIGEST_CAP): string[] {
  return raw.slice(0, cap).map((e) => `${e.role}: "${(e.name || "").replace(/\s+/g, " ").trim().slice(0, 60)}"`);
}

export function isDestructiveStep(text: string): boolean {
  return DESTRUCTIVE.test(text);
}

/** Expand `{tag}` → run tag and `{edge:*}` → fuzz values in a step/value. Pure — selftested. */
export function expandTokens(text: string, tag: string): string {
  return expandEdgeTokens(text.replace(/\{tag\}/g, tag));
}

/** Candidate locators in RESOLVE_ORDER priority — first visible one wins. */
function candidates(page: Page, target: string): Locator[] {
  const t = stripTarget(target);
  return [
    page.getByRole("button", { name: t }),
    page.getByRole("link", { name: t }),
    page.getByLabel(t),
    page.getByPlaceholder(t),
    page.getByText(t, { exact: true }),
    page.getByText(t, { exact: false }),
  ];
}

async function firstVisible(locs: Locator[]): Promise<Locator | null> {
  for (const l of locs) {
    const one = l.first();
    if ((await one.count().catch(() => 0)) > 0 && (await one.isVisible().catch(() => false))) return one;
  }
  return null;
}

/** Persona = Executor behavior only (P5.1b). Mobile/slow-network applied here; keyboard-only in execute(). */
async function applyPersona(page: Page, persona?: Journey["persona"]): Promise<void> {
  if (persona === "mobile") {
    // ponytail: viewport only, not a full mobile device context (no touch/UA). Upgrade to a device profile if mobile auth/UA branching breaks.
    await page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
  } else if (persona === "slow-network") {
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    await cdp?.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 }).catch(() => {});
  }
}

/** Extract a capped, labelled digest of visible interactive elements — shared by the journey Navigator and the explorer. */
export async function pageDigest(page: Page, cap: number = DIGEST_CAP): Promise<string[]> {
  const raw = await page.evaluate((c: number) => {
    const sel = "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], [role=menuitem]";
    const out: { role: string; name: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (out.length >= c) break;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const he = el as HTMLElement;
      const name = (el.getAttribute("aria-label") || he.innerText || el.getAttribute("placeholder") || el.getAttribute("name") || (el as HTMLInputElement).value || "").trim();
      out.push({ role: el.getAttribute("role") || el.tagName.toLowerCase(), name });
    }
    return out;
  }, cap).catch(() => [] as { role: string; name: string }[]);
  return buildDigest(raw, cap);
}

export async function execute(page: Page, a: NavAction, tag: string, persona?: Journey["persona"]): Promise<boolean> {
  const value = a.value ? expandTokens(a.value, tag) : "";
  if (a.action === "goto" && a.target) { await page.goto(a.target, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}); return true; }
  if (a.action === "press" && value) { await page.keyboard.press(value).catch(() => {}); return true; }
  if (!a.target) return false;
  if (UNSAFE.test(a.target)) return false; // safety: never click logout/delete/api targets

  const loc = await firstVisible(candidates(page, a.target));
  if (!loc) return false;
  if (a.action === "fill") {
    await loc.fill(value).catch(() => {});
  } else if (a.action === "select") {
    await loc.selectOption({ label: value }).catch(() => loc.selectOption({ index: 1 }).catch(() => {}));
  } else {
    if (persona === "keyboard-only") { await loc.focus().catch(() => {}); await page.keyboard.press("Enter").catch(() => {}); }
    else await loc.click({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(700);
  return true;
}

/** Deterministic Verifier (P5.2): do distinctive goal words appear on the page now? */
async function verifyGoal(page: Page, goal: string): Promise<boolean> {
  const words = goal.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  if (!words.length) return true;
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
  return words.some((w) => text.includes(w));
}

async function callNavigator(journey: Journey, stepText: string, role: string, url: string, digest: string[], transcript: string[]): Promise<{ action: NavAction | null; tokens: number }> {
  // ponytail: digest is text-only to the model to fit the ~8k/journey budget;
  // screenshots are still saved for the replayable timeline, just not sent as
  // vision. Add per-action screenshots to the call if the digest proves too thin.
  const prompt = `You are driving a web app to complete a business flow, one action at a time.
Flow goal: ${journey.goal}
Current step (acting as ${role}): ${stepText}
Current URL: ${url}
Visible interactive elements:
${digest.join("\n") || "(none detected)"}
Actions so far:
${transcript.slice(-12).join("\n") || "(none yet)"}
Pick the SINGLE next action. Call step_done when this step is achieved, journey_done when the whole goal is met, stuck if you cannot progress. Do not repeat an action listed above that had no effect.`;
  const res = await aiToolCall({ maxTokens: 400, tool: { name: ACTION_TOOL.name, description: ACTION_TOOL.description, schema: ACTION_TOOL.input_schema }, text: prompt });
  const action = (res?.input as NavAction | null) ?? null;
  return { action: action && action.action ? action : null, tokens: res?.tokens ?? 0 };
}

async function runJourney(ctx: RunContext, sessions: Session[], project: Project, journey: Journey, tokenCap: number): Promise<number> {
  if (project.envTag === "production" && journey.steps.some((s) => isDestructiveStep(s.text))) {
    ctx.log(AGENT, "warn", `Journey "${journey.name}" skipped on production — it contains destructive step(s) (same posture as CRUD).`);
    return 0;
  }
  const byRole = new Map(sessions.map((s) => [s.role.name, s.browserCtx]));
  const tag = crudTag(ctx.runId);
  const transcript: string[] = [];
  const maxActions = journey.maxActions ?? DEFAULT_MAX_ACTIONS;
  let tokens = 0;
  let stepIdx = 0;
  let currentRole = "";
  let page: Page | null = null;
  let lastShot: string | null = null;

  // Returns the new page (rather than assigning the outer `page` from inside a
  // closure) so TS control-flow can track that `page` is non-null after the call.
  const openFor = async (roleName: string): Promise<Page> => {
    const bc = byRole.get(roleName) ?? sessions[0].browserCtx;
    const pg = await bc.newPage();
    await applyPersona(pg, journey.persona);
    await pg.goto(project.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    currentRole = roleName;
    return pg;
  };

  const fail = (idx: number, why: string): void => {
    ctx.finding({
      agent: AGENT, severity: "high", role: journey.steps[idx]?.role ?? null, pageUrl: page?.url() ?? project.baseUrl,
      title: `Business flow "${journey.name}" broke at step ${idx + 1}: ${journey.steps[idx]?.text ?? ""}`,
      detail: `${why}\n\nActions taken:\n${transcript.join("\n") || "(none)"}`,
      evidence: lastShot,
    });
  };

  try {
    page = await openFor(journey.steps[0]?.role ?? sessions[0].role.name);
    for (let action = 0; action < maxActions && stepIdx < journey.steps.length; action++) {
      if (tokens >= tokenCap) { fail(stepIdx, `Ran out of AI token budget (${tokenCap}) before the flow completed.`); return tokens; }
      const step = journey.steps[stepIdx];
      if (step.role !== currentRole) { await page.close().catch(() => {}); page = await openFor(step.role); } // cross-role step = multi-user testing (P5.1)
      const p = page;

      const digest = await pageDigest(p);
      ctx.status(AGENT, `Journey "${journey.name}" step ${stepIdx + 1} as ${currentRole}: ${step.text}`, { url: p.url() });
      ctx.recordTested(p.url(), AGENT); // V4 coverage matrix — journeys visit pages directly, not via sampleFor
      lastShot = await ctx.screenshot(p, `journey-${journey.name}-${action}`, { role: currentRole });

      const stepText = expandTokens(step.text + (step.expect ? ` (success looks like: ${step.expect})` : ""), tag);
      const nav = await callNavigator(journey, stepText, currentRole, p.url(), digest, transcript);
      tokens += nav.tokens;
      const a = nav.action;
      if (!a) { fail(stepIdx, "The Navigator returned no usable action (AI unavailable or malformed)."); return tokens; }
      transcript.push(`[${currentRole}] ${a.action}${a.target ? ` "${a.target}"` : ""}${a.value ? ` = ${a.value}` : ""}${a.why ? ` — ${a.why}` : ""}`);

      if (a.action === "journey_done") {
        const verified = await verifyGoal(p, journey.goal);
        ctx.coverage.journeysPassed++;
        ctx.finding({
          agent: AGENT, severity: "info", kind: "improvement", role: currentRole, pageUrl: p.url(),
          title: `Business flow "${journey.name}" passed`,
          detail: `Completed in ${action + 1} action(s) across ${journey.steps.length} step(s).${verified ? " Goal text confirmed on the final page." : " Note: could not independently confirm the goal text — review the screenshots."}\n\nActions:\n${transcript.join("\n")}`,
          evidence: lastShot,
        });
        ctx.log(AGENT, "pass", `Journey "${journey.name}" passed (${tokens} tokens)`);
        return tokens;
      }
      if (a.action === "stuck") { fail(stepIdx, `Navigator reported it was stuck: ${a.why ?? ""}`); return tokens; }
      if (a.action === "step_done") {
        // Per-step assertion (Plan-v5 R6): if the step declares an expected observable,
        // verify it's on the page now. A cross-role step with `expect` is the black-box
        // cross-user-sync check (role B must now see what role A created).
        const expect = step.expect ? expandTokens(step.expect, tag) : "";
        if (expect && !(await verifyGoal(p, expect))) {
          ctx.finding({ agent: AGENT, severity: "high", role: currentRole, pageUrl: p.url(),
            title: `Business flow "${journey.name}" — step ${stepIdx + 1} expectation not met`,
            detail: `After "${step.text}", expected to see "${step.expect}" on the page (as ${currentRole}) but it was not found. ${step.role !== journey.steps[Math.max(0, stepIdx - 1)]?.role ? "This is a cross-user check — the change another role made did not propagate to this role's view." : ""}\n\nActions so far:\n${transcript.join("\n")}`,
            evidence: lastShot });
        }
        stepIdx++;
        continue;
      }

      const ok = await execute(p, a, tag, journey.persona);
      if (!ok) transcript.push(`  ↳ could not resolve "${a.target ?? ""}"`);
    }
    // Loop ended without journey_done.
    if (stepIdx >= journey.steps.length) {
      ctx.coverage.journeysPassed++;
      ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: currentRole, pageUrl: page?.url() ?? project.baseUrl,
        title: `Business flow "${journey.name}" completed all steps`,
        detail: `All ${journey.steps.length} step(s) reached.\n\nActions:\n${transcript.join("\n")}`, evidence: lastShot });
    } else {
      fail(stepIdx, `Hit the ${maxActions}-action budget before finishing the flow.`);
    }
    return tokens;
  } catch (e) {
    fail(stepIdx, `Journey crashed: ${String(e).slice(0, 200)}`);
    return tokens;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Journey engine (Plan-v4 P5) — the "test like a human" centerpiece. For each
 * user-defined business flow it runs a Navigator(AI)→Executor(code)→Verifier(code)
 * loop: the AI looks at a cheap text digest of the page and the running transcript,
 * decides ONE semantic action, code resolves+performs it, and step/journey
 * completion is checked deterministically. Cross-role steps switch to another
 * role's already-open session (multi-user flows) with no new login. Smart/full
 * only; per-journey token + action caps; destructive verbs refused on production.
 */
export async function journeyAgent(ctx: RunContext, sessions: Session[], project: Project, mode: RunMode, tokenBudget: number): Promise<number> {
  const journeys = project.journeys ?? [];
  ctx.coverage.journeysDefined += journeys.length;
  if (mode === "quick") { ctx.log(AGENT, "warn", "Journeys run in smart/full only — skipped."); return 0; }
  if (!journeys.length) { ctx.log(AGENT, "step", "No business journeys defined for this project — skipping."); return 0; }
  if (!aiAvailable()) { ctx.log(AGENT, "warn", "Journeys need an AI key for the Navigator — skipped."); return 0; }
  if (!sessions.length) { ctx.log(AGENT, "warn", "No established sessions — cannot run journeys."); return 0; }

  let spent = 0;
  const perJourney = Math.max(2000, Math.floor(tokenBudget / journeys.length));
  for (const j of journeys) {
    if (spent >= tokenBudget) { ctx.log(AGENT, "warn", `Token budget exhausted — skipping remaining journey "${j.name}".`); break; }
    const cap = Math.min(perJourney, tokenBudget - spent, PER_JOURNEY_TOKEN_CAP);
    spent += await runJourney(ctx, sessions, project, j, cap);
  }
  ctx.log(AGENT, "pass", `Ran ${journeys.length} journey(s), ${ctx.coverage.journeysPassed} passed, ${spent} AI tokens`);
  return spent;
}
