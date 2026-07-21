import { RunContext } from "../context";
import { listFindings } from "../../db";
import type { Project, RunReport, SeniorReview, Finding } from "../../types";
import { aiAvailable, aiProviderLabel, aiToolCall } from "../ai";

const AGENT = "senior-review";

const SENIOR_TOOL = {
  name: "senior_review",
  description: "Summarize the whole run as a senior QA lead: business-risk ordering, no invented findings.",
  input_schema: {
    type: "object" as const,
    properties: {
      executive_summary: { type: "string", description: "2-4 sentences: is this app shippable, and the single biggest risk." },
      fix_first: {
        type: "array", maxItems: 3,
        items: {
          type: "object",
          properties: { title: { type: "string" }, why_business_impact: { type: "string" } },
          required: ["title", "why_business_impact"],
        },
      },
      watchlist: { type: "array", items: { type: "string" }, description: "Lower-priority things to keep an eye on." },
    },
    required: ["executive_summary", "fix_first", "watchlist"],
  },
};

const RANK: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * Senior QA reviewer (Plan-v4 P6). One AI call AFTER everything else: it reads
 * the assembled report (coverage, recurrence patterns, root-cause clusters) plus
 * the top findings and writes an executive summary ordered by BUSINESS risk, not
 * severity count. It may only reason over findings actually in the input — the
 * prompt forbids inventing new ones. Result is stored on the report and echoed as
 * one info finding so it also appears in the findings stream. Returns tokens used.
 */
export async function seniorReviewerAgent(ctx: RunContext, project: Project, report: RunReport, tokenBudget: number): Promise<number> {
  if (tokenBudget <= 0 || !aiAvailable()) {
    ctx.log(AGENT, "warn", "Skipped — needs AI (set ANTHROPIC_API_KEY / OPENROUTER_API_KEY) and a non-zero budget.");
    return 0;
  }
  const findings = listFindings(ctx.runId)
    .filter((f) => f.agent !== AGENT)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, 30);
  if (!findings.length) {
    ctx.log(AGENT, "step", "Nothing to review — no findings this run.");
    return 0;
  }

  const cov = report.coverageTotals;
  const prompt = `You are the senior QA lead signing off on a black-box test run of a web app. Focus area: ${project.notes || "general quality"}.
${ctx.siteProfile ? `Site type: ${ctx.siteProfile.kind}${ctx.siteProfile.framework ? ` (${ctx.siteProfile.framework})` : ""}.` : ""}
Coverage: ${cov ? `${cov.pagesTested}/${cov.pagesDiscovered} pages, ${cov.controlsClicked}/${cov.controlsSeen} controls${(cov.journeysDefined ?? 0) > 0 ? `, ${cov.journeysPassed}/${cov.journeysDefined} business journeys passed` : ""}.` : "n/a"}
${report.patterns?.recurrent.length ? `Recurring across recent runs: ${report.patterns.recurrent.slice(0, 5).map((r) => `${r.title} (${r.runsSeen}/${r.totalRuns})`).join("; ")}.` : ""}
${ctx.rootCauses.length ? `Root-cause clusters: ${ctx.rootCauses.map((c) => `${c.signature} hits ${c.pages.length} pages`).join("; ")}.` : ""}

Findings (severity-ranked, top ${findings.length}):
${findings.map((f) => `- [${f.severity}] ${f.title}${f.pageUrl ? ` @ ${f.pageUrl}` : ""}`).join("\n")}

Call senior_review. Order fix_first by BUSINESS impact, not by how many issues a category has — e.g. "a11y found more issues, but a broken checkout blocks revenue, fix that first". Do NOT invent findings that are not in the list above.`;

  try {
    const result = await aiToolCall({
      maxTokens: Math.min(1200, tokenBudget),
      tool: { name: SENIOR_TOOL.name, description: SENIOR_TOOL.description, schema: SENIOR_TOOL.input_schema },
      text: prompt,
    });
    const review = result?.input as SeniorReview | null;
    if (!review || !review.executive_summary) {
      ctx.log(AGENT, "warn", "AI returned no usable summary.");
      return result?.tokens ?? 0;
    }
    review.fix_first = (review.fix_first ?? []).slice(0, 3);
    review.watchlist = review.watchlist ?? [];
    report.seniorReview = review;

    const detail = [
      review.executive_summary,
      review.fix_first.length ? "\nFix first:\n" + review.fix_first.map((x, i) => `${i + 1}. ${x.title} — ${x.why_business_impact}`).join("\n") : "",
      review.watchlist.length ? "\nWatchlist:\n" + review.watchlist.map((w) => `• ${w}`).join("\n") : "",
    ].filter(Boolean).join("\n");
    ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", source: "ai", confidence: 0.7, role: null, pageUrl: null,
      title: "Senior QA sign-off", detail, evidence: null });

    const tokens = result?.tokens ?? 0;
    ctx.log(AGENT, "pass", `Senior review written — ${review.fix_first.length} fix-first item(s), ${tokens} tokens (${aiProviderLabel()})`);
    return tokens;
  } catch (e) {
    ctx.log(AGENT, "warn", `Senior review failed: ${String(e).slice(0, 200)}`);
    return 0;
  }
}
