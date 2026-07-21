import type { BrowserContext, Page } from "playwright";
import type { RoleCred, RunMode, Severity } from "../../types";
import { RunContext } from "../context";
import { aiAvailable, aiProviderLabel, aiToolCall } from "../ai";
import { pageDigest, execute, type NavAction } from "./journey";
import { crudTag } from "./crud";
import { UNSAFE } from "./crawler";

const AGENT = "explorer";
const MAX_ACTIONS = 14; // wander budget per run
const PER_CALL_TOKENS = 350;

interface ExploreResult {
  action: NavAction["action"]; // reuse the journey action verbs; "journey_done" = "done exploring"
  target?: string;
  value?: string;
  why?: string;
  finding?: { severity: Severity; title: string; detail: string };
}

const EXPLORE_TOOL = {
  name: "explore",
  description: "Behave like a curious human tester on an app you've never seen. Pick the single next thing to try, and report anything broken/confusing you notice.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["click", "fill", "select", "press", "goto", "journey_done", "stuck"] },
      target: { type: "string", description: "What to act on in plain words (e.g. 'the Menu button'), or a URL for goto." },
      value: { type: "string", description: "Text to type / option / key." },
      why: { type: "string", description: "One sentence: what you're curious about or testing." },
      finding: {
        type: "object",
        description: "Only if you noticed something actually broken/wrong/confusing on the CURRENT page. Omit otherwise.",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["severity", "title", "detail"],
      },
    },
    required: ["action", "why"],
  },
};

/**
 * AI Explorer (Plan-v5 R.explorer / Plan-v4 P5.7) — the "test like a curious
 * human, no script" capability, gated behind the journey guardrails that now
 * exist. Smart/full + AI. Starts at the riskiest page and lets the model wander:
 * each turn it sees a text digest + transcript, picks ONE action, and may report
 * a finding it noticed. Deterministic safety net: console/page errors during the
 * wander are captured and filed regardless of what the model says. UNSAFE targets
 * are refused; destructive-verb runs are kept off production by the caller.
 * Returns tokens used.
 */
export async function explorerAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, mode: RunMode, tokenBudget: number): Promise<number> {
  if (mode === "quick") { ctx.log(AGENT, "warn", "Explorer runs in smart/full only — skipped."); return 0; }
  if (!aiAvailable()) { ctx.log(AGENT, "warn", "Explorer needs an AI key — skipped."); return 0; }
  if (tokenBudget <= 0) { ctx.log(AGENT, "warn", "Explorer has no token budget — skipped."); return 0; }
  const start = ctx.sampleFor(role.name, 1, AGENT)[0];
  if (!start) { ctx.log(AGENT, "warn", `No page to explore for ${role.name}.`); return 0; }

  const tag = crudTag(ctx.runId);
  const transcript: string[] = [];
  let tokens = 0, findings = 0;
  const page: Page = await browserCtx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on("dialog", (d) => void d.dismiss().catch(() => {}));

  try {
    await page.goto(start.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    for (let step = 0; step < MAX_ACTIONS && tokens < tokenBudget; step++) {
      const digest = await pageDigest(page);
      ctx.status(AGENT, `Free-roam exploring as ${role.name}`, { url: page.url() });
      const shot = await ctx.screenshot(page, `explore-${step}`, { role: role.name });
      const prompt = `You are a curious QA tester exploring a ${ctx.siteProfile?.kind ?? "web"} app to find bugs and confusing UX. No script — follow your instincts.
Current URL: ${page.url()}
Visible interactive elements:
${digest.join("\n") || "(none detected)"}
What you've tried:
${transcript.slice(-10).join("\n") || "(nothing yet)"}
Pick ONE next action a curious user would try (open a menu, submit a form, change a value, revisit a page). If you see something broken/wrong/confusing on THIS page, include a finding. Call journey_done when you've explored enough or hit a dead end. Do not repeat a tried action that did nothing.`;
      const res = await aiToolCall({ maxTokens: PER_CALL_TOKENS, tool: { name: EXPLORE_TOOL.name, description: EXPLORE_TOOL.description, schema: EXPLORE_TOOL.input_schema }, text: prompt });
      tokens += res?.tokens ?? 0;
      const a = res?.input as ExploreResult | null;
      if (!a || !a.action) break;

      if (a.finding && a.finding.title) {
        findings++;
        ctx.finding({ agent: AGENT, severity: a.finding.severity, kind: "bug", source: "ai", confidence: 0.6, role: role.name, pageUrl: page.url(),
          title: a.finding.title, detail: `${a.finding.detail}\n\n(Found while exploring freely.)`, evidence: shot });
      }
      transcript.push(`${a.action}${a.target ? ` "${a.target}"` : ""}${a.value ? ` = ${a.value}` : ""}${a.why ? ` — ${a.why}` : ""}`);
      if (a.action === "journey_done" || a.action === "stuck") break;
      if (a.target && UNSAFE.test(a.target)) { transcript.push("  ↳ refused (unsafe target)"); continue; }

      const before = consoleErrors.length;
      await execute(page, a as NavAction, tag);
      // Deterministic net: any new console/page error during this action is a real finding regardless of AI judgment.
      if (consoleErrors.length > before) {
        findings++;
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: page.url(),
          title: `Error while exploring: ${a.action}${a.target ? ` "${a.target}"` : ""}`,
          detail: `A console/page error fired during exploration:\n${consoleErrors.slice(before).join("\n")}`, evidence: await ctx.screenshot(page, `explore-error-${step}`) });
      }
    }
    ctx.log(AGENT, "pass", `Explored ${transcript.length} action(s) for ${role.name}, ${findings} finding(s), ${tokens} tokens (${aiProviderLabel()})`);
  } catch (e) {
    ctx.log(AGENT, "warn", `Explorer errored: ${String(e).slice(0, 180)}`);
  } finally {
    await page.close();
  }
  return tokens;
}
