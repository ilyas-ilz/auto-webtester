import type { BrowserContext } from "playwright";
import { RunContext, scrollToBottom } from "../context";
import type { Project, RunMode, Severity } from "../../types";
import { aiAvailable, aiProviderLabel, aiToolCall } from "../ai";

const AGENT = "page-judge";
const MAX_JUDGED_PAGES = 4;

const JUDGE_TOOL = {
  name: "report_page_findings",
  description: "Report what is broken, missing, or wrong on this page from a user's point of view.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            kind: { type: "string", enum: ["bug", "improvement"] },
            title: { type: "string" },
            detail: { type: "string" },
          },
          required: ["severity", "kind", "title", "detail"],
        },
      },
    },
    required: ["findings"],
  },
};

interface JudgeFinding { severity: Severity; kind: "bug" | "improvement"; title: string; detail: string }

/**
 * Which pages the AI eye looks at: one representative per inferred page type
 * first (widest semantic spread), then top up with the highest-ranked unseen
 * pages until MAX_JUDGED_PAGES. The top-up matters — on sites where the type
 * inferrer collapses everything to one type (dashboard-style SaaS) the judge
 * would otherwise look at a single page and leave its whole budget unspent.
 * `ranked` is the crawled pages in priority order.
 */
export function pickJudgeTargets(pageTypes: ReadonlyMap<string, string>, ranked: readonly string[], max = MAX_JUDGED_PAGES): [string, string][] {
  const targets: [string, string][] = [];
  const taken = new Set<string>();
  const byType = new Map<string, string>();
  for (const [url, type] of pageTypes) if (!byType.has(type)) byType.set(type, url);
  for (const [type, url] of byType) {
    if (targets.length >= max) break;
    targets.push([type, url]);
    taken.add(url);
  }
  for (const url of ranked) {
    if (targets.length >= max) break;
    if (taken.has(url)) continue;
    targets.push([pageTypes.get(url) ?? "unknown", url]);
    taken.add(url);
  }
  return targets;
}

/**
 * Scroll fractions (0 = top, 1 = bottom) at which to capture viewport shots for
 * the AI judge. Full mode + tall page gets extra below-the-fold shots so the AI
 * sees semantic visual issues (broken pricing section, off-brand footer) that
 * deterministic agents can't judge and a single top-viewport shot misses. A
 * single stitched/fullPage image was rejected: the model downscales it and
 * small defects vanish. Smart mode stays at one shot — breadth over depth.
 */
export function judgeShotFractions(pageHeight: number, viewportHeight: number, mode: RunMode): number[] {
  if (mode !== "full" || viewportHeight <= 0) return [0];
  const ratio = pageHeight / viewportHeight;
  if (ratio >= 5) return [0, 0.5, 1];
  if (ratio >= 2) return [0, 1];
  return [0];
}

/**
 * AI page judge — the "human glance" layer. For a handful of representative
 * pages it looks at a real screenshot plus the page text and asks: for this
 * kind of site and this kind of page, is anything visibly broken, missing, or
 * wrong? This is the semantic check the deterministic agents cannot do.
 * Smart/full mode only; shares the run's AI token budget and stops when its
 * slice is spent. Returns tokens used.
 */
export async function pageJudgeAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, tokenBudget: number, mode: RunMode = "smart"): Promise<number> {
  if (tokenBudget <= 0) {
    ctx.log(AGENT, "warn", "Skipped — AI token budget is 0 for this mode.");
    return 0;
  }
  if (!aiAvailable()) {
    ctx.log(AGENT, "warn", "Skipped — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY to enable the AI page judge.");
    return 0;
  }

  // One representative per page type (the expectations agent already mapped
  // url → type), then top up with other crawled pages so the budget is used.
  // Full mode judges more pages — the loop still stops the moment the slice is
  // spent, so a higher cap only spends budget that would otherwise go unused.
  const targets = pickJudgeTargets(ctx.pageTypes, ctx.pages.map((p) => p.url), mode === "full" ? 8 : MAX_JUDGED_PAGES);
  if (!targets.length) {
    ctx.log(AGENT, "warn", "Skipped — no crawled pages to judge.");
    return 0;
  }

  const site = ctx.siteProfile;
  let spent = 0;
  let judged = 0;

  for (const [pageType, url] of targets) {
    if (spent >= tokenBudget) {
      ctx.log(AGENT, "warn", `Stopping — AI budget slice spent (${spent}/${tokenBudget} tokens).`);
      break;
    }
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await scrollToBottom(page).catch(() => {});
      // Viewport shots, not fullPage — a tall fullPage image gets downscaled by
      // the model and small defects vanish. Full mode adds mid/bottom shots on
      // tall pages so the AI also sees below the fold (see judgeShotFractions).
      const { pageH, viewH } = await page.evaluate(() => ({ pageH: document.body?.scrollHeight ?? 0, viewH: window.innerHeight }));
      const fractions = judgeShotFractions(pageH, viewH, mode);
      const shots: string[] = [];
      for (const f of fractions) {
        await page.evaluate((fr) => window.scrollTo(0, (document.body.scrollHeight - window.innerHeight) * fr), f).catch(() => {});
        if (f > 0) await page.waitForTimeout(250); // let sticky headers/animations settle
        shots.push((await page.screenshot()).toString("base64"));
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const text = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1500));
      const evidence = await ctx.screenshot(page, `judge-${pageType}`);

      const result = await aiToolCall({
        maxTokens: Math.min(700, tokenBudget - spent),
        tool: { name: JUDGE_TOOL.name, description: JUDGE_TOOL.description, schema: JUDGE_TOOL.input_schema },
        imagePngBase64: shots.length === 1 ? shots[0] : shots,
        text: `You are a senior QA engineer looking at one page like a real user would.
Site type: ${site ? `${site.kind}${site.framework ? ` (${site.framework})` : ""}` : "unknown"}. Page type: ${pageType}. URL: ${url}.
Focus: ${project.notes || "general functional and UX review"}.
${shots.length > 1 ? `The ${shots.length} screenshots are sections of the same page in top-to-bottom order (top${shots.length === 3 ? ", middle" : ""} and bottom).` : ""}
Visible page text (truncated): ${text}

From the screenshot${shots.length > 1 ? "s" : ""} + text, report 0-3 findings a user would actually notice: broken layout, missing/placeholder content, wrong or inconsistent information, non-functional-looking UI, confusing UX. Judge by the standards of this site/page type. Do not invent things you cannot see. Report nothing if the page looks fine.`,
      });
      spent += result?.tokens ?? 0;
      const findings = ((result?.input as { findings?: JudgeFinding[] } | null)?.findings ?? []).filter((f) => f && f.title);
      for (const f of findings.slice(0, 3)) {
        ctx.finding({ agent: AGENT, severity: f.severity, kind: f.kind, source: "ai", confidence: 0.7, role: null, pageUrl: url, title: f.title, detail: f.detail, evidence });
      }
      judged++;
      ctx.log(AGENT, "step", `Judged ${url} (${pageType}, ${shots.length} shot(s)): ${findings.length} finding(s)`);
    } catch (e) {
      ctx.log(AGENT, "warn", `Judge failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  ctx.log(AGENT, "pass", `AI-judged ${judged} of ${targets.length} representative page(s), ${spent} tokens (${aiProviderLabel()})`);
  return spent;
}
