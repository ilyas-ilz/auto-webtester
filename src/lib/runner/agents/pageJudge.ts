import type { BrowserContext } from "playwright";
import { RunContext, scrollToBottom } from "../context";
import type { Project, Severity } from "../../types";
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
 * AI page judge — the "human glance" layer. For a handful of representative
 * pages it looks at a real screenshot plus the page text and asks: for this
 * kind of site and this kind of page, is anything visibly broken, missing, or
 * wrong? This is the semantic check the deterministic agents cannot do.
 * Smart/full mode only; shares the run's AI token budget and stops when its
 * slice is spent. Returns tokens used.
 */
export async function pageJudgeAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, tokenBudget: number): Promise<number> {
  if (tokenBudget <= 0) {
    ctx.log(AGENT, "warn", "Skipped — AI token budget is 0 for this mode.");
    return 0;
  }
  if (!aiAvailable()) {
    ctx.log(AGENT, "warn", "Skipped — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY to enable the AI page judge.");
    return 0;
  }

  // One representative per page type (the expectations agent already mapped
  // url → type); fall back to the first crawled pages if it didn't run.
  const byType = new Map<string, string>();
  for (const [url, type] of ctx.pageTypes) if (!byType.has(type)) byType.set(type, url);
  const targets = (byType.size ? Array.from(byType.entries()) : ctx.pages.slice(0, MAX_JUDGED_PAGES).map((p) => ["unknown", p.url] as [string, string]))
    .slice(0, MAX_JUDGED_PAGES);
  if (!targets.length) {
    ctx.log(AGENT, "warn", "Skipped — no crawled pages to judge.");
    return 0;
  }

  const site = ctx.siteProfile;
  let spent = 0;

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
      const shotBuffer = await page.screenshot(); // viewport only — full-page images blow the token budget
      const text = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1500));
      const evidence = await ctx.screenshot(page, `judge-${pageType}`);

      const result = await aiToolCall({
        maxTokens: Math.min(700, tokenBudget - spent),
        tool: { name: JUDGE_TOOL.name, description: JUDGE_TOOL.description, schema: JUDGE_TOOL.input_schema },
        imagePngBase64: shotBuffer.toString("base64"),
        text: `You are a senior QA engineer looking at one page like a real user would.
Site type: ${site ? `${site.kind}${site.framework ? ` (${site.framework})` : ""}` : "unknown"}. Page type: ${pageType}. URL: ${url}.
Focus: ${project.notes || "general functional and UX review"}.
Visible page text (truncated): ${text}

From the screenshot + text, report 0-3 findings a user would actually notice: broken layout, missing/placeholder content, wrong or inconsistent information, non-functional-looking UI, confusing UX. Judge by the standards of this site/page type. Do not invent things you cannot see. Report nothing if the page looks fine.`,
      });
      spent += result?.tokens ?? 0;
      const findings = ((result?.input as { findings?: JudgeFinding[] } | null)?.findings ?? []).filter((f) => f && f.title);
      for (const f of findings.slice(0, 3)) {
        ctx.finding({ agent: AGENT, severity: f.severity, kind: f.kind, source: "ai", confidence: 0.7, role: null, pageUrl: url, title: f.title, detail: f.detail, evidence });
      }
      ctx.log(AGENT, "step", `Judged ${url} (${pageType}): ${findings.length} finding(s)`);
    } catch (e) {
      ctx.log(AGENT, "warn", `Judge failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  ctx.log(AGENT, "pass", `AI-judged ${Math.min(targets.length, MAX_JUDGED_PAGES)} representative page(s), ${spent} tokens (${aiProviderLabel()})`);
  return spent;
}
