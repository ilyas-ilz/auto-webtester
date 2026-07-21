import { RunContext, type CrawledPage } from "../context";
import type { Project, Severity, GraphNode } from "../../types";
import { listGraphNodes } from "../../db";
import { aiAvailable, aiProviderLabel, aiToolCall } from "../ai";

const AGENT = "ai-reviewer";
const MAX_PAGES = 8;

const REPORT_TOOL = {
  name: "report_findings",
  description: "Report senior-QA findings for the pages reviewed.",
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
            pageUrl: { type: "string" },
            title: { type: "string" },
            detail: { type: "string" },
          },
          required: ["severity", "kind", "pageUrl", "title", "detail"],
        },
      },
    },
    required: ["findings"],
  },
};

interface AiFinding { severity: Severity; kind: "bug" | "improvement"; pageUrl: string; title: string; detail: string }

/**
 * Reasoning agent (Plan-v2 plane 4, trimmed to one pass for now). Only runs
 * in smart/full mode and only if ANTHROPIC_API_KEY is set — deterministic
 * layer works standalone with zero LLM cost otherwise. Every AI finding is
 * `source: 'ai'` with a confidence < 1 and no invented evidence, per the
 * plan's "AI never asserts without a deterministic artifact behind it" rule
 * — it reasons over pages the crawler already visited and screenshotted.
 *
 * `tokenBudget` is the cost guardrail (§5.1 `budget.aiTokens`, "per-run AI
 * cost dashboard"): the call's own max_tokens is capped at the budget so a
 * misconfigured budget can't be blown by output length, and the gate is
 * enforced here too (not just at the useAI call site) so this agent is safe
 * to call directly without trusting every caller to check first.
 */
export async function aiReviewerAgent(ctx: RunContext, project: Project, tokenBudget: number): Promise<number> {
  if (tokenBudget <= 0) {
    ctx.log(AGENT, "warn", "Skipped — AI token budget is 0 for this mode.");
    return 0;
  }
  if (!aiAvailable()) {
    ctx.log(AGENT, "warn", "Skipped — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY to enable AI business-logic/UX review.");
    return 0;
  }

  interface PageBrief { url: string; risk: number; title: string; consoleErrors: number }
  const riskNodes = listGraphNodes(project.id, "page").slice(0, MAX_PAGES);
  const pageBriefs: PageBrief[] = riskNodes.map((n: GraphNode) => {
    const p = ctx.pages.find((cp: CrawledPage) => cp.url === (n.attrs.url as string));
    return { url: n.attrs.url as string, risk: n.riskScore, title: p?.title ?? n.label, consoleErrors: p?.consoleErrors.length ?? 0 };
  });
  if (!pageBriefs.length) {
    ctx.log(AGENT, "warn", "Skipped — no crawled pages to review.");
    return 0;
  }

  const site = ctx.siteProfile;
  const prompt = `You are a senior QA engineer reviewing a web app. Focus: ${project.notes || "general functional and UX review"}.
${site ? `Site type: ${site.kind}${site.framework ? ` (${site.framework})` : ""} — judge it by the standards of that category. Signals: ${site.signals.join("; ")}.` : ""}
Pages crawled (highest risk first):
${pageBriefs.map((p: PageBrief) => `- ${p.url} — "${p.title}" (risk ${p.risk}, ${p.consoleErrors} console error(s))`).join("\n")}
${ctx.lighthouse.length ? `\nLighthouse lab audit:\n${ctx.lighthouse.map((l) => `- ${l.url} — perf ${l.scores.performance}, a11y ${l.scores.accessibility}, best-practices ${l.scores.bestPractices}, seo ${l.scores.seo}, LCP ${l.lcpMs ? `${(l.lcpMs / 1000).toFixed(1)}s` : "n/a"}, CLS ${l.cls ?? "n/a"}`).join("\n")}` : ""}

Call report_findings with 0-6 findings: real bugs you can infer from this data (missing content, error-prone pages) AND senior-level improvement suggestions (UX, business logic, industry-standard comparisons). Do not invent findings about pages not listed. Skip if nothing notable.`;

  try {
    const result = await aiToolCall({
      maxTokens: Math.min(1500, tokenBudget),
      tool: { name: REPORT_TOOL.name, description: REPORT_TOOL.description, schema: REPORT_TOOL.input_schema },
      text: prompt,
    });
    const findings = ((result?.input as { findings?: AiFinding[] } | null)?.findings ?? []).filter((f) => f && f.title);
    for (const f of findings.slice(0, 6)) {
      ctx.finding({ agent: AGENT, severity: f.severity, kind: f.kind, source: "ai", confidence: 0.7, role: null, pageUrl: f.pageUrl || null, title: f.title, detail: f.detail, evidence: null });
    }
    const tokens = result?.tokens ?? 0;
    ctx.log(AGENT, "pass", `AI review complete — ${findings.length} finding(s), ${tokens}/${tokenBudget} budgeted tokens (${aiProviderLabel()})`);
    if (tokens > tokenBudget) {
      ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", source: "ai", confidence: 1, role: null, pageUrl: null,
        title: `AI review exceeded its token budget (${tokens} > ${tokenBudget})`,
        detail: "Input context (page count/notes length) is pushing past the configured per-mode ceiling — consider a smaller sample or a shorter focus prompt.", evidence: null });
    }
    return tokens;
  } catch (e) {
    ctx.log(AGENT, "warn", `AI review failed: ${String(e).slice(0, 200)}`);
    return 0;
  }
}
