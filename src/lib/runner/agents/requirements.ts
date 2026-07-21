import { RunContext } from "../context";
import { listFindings, listGraphNodes } from "../../db";
import type { Project, Severity } from "../../types";
import { aiAvailable, aiProviderLabel, aiToolCall } from "../ai";

const AGENT = "requirements";
const MAX_REQS = 20;
const MAX_PAGES = 15;
const MAX_EVIDENCE = 20;

/**
 * Parse free-text acceptance criteria into a clean list (Plan-v5 R1). One
 * requirement per line; leading bullets/numbering stripped; blanks and dupes
 * dropped; capped so a pasted PRD can't blow the token budget. Pure — selftested.
 */
export function parseRequirements(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (line.length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, 300));
    if (out.length >= MAX_REQS) break;
  }
  return out;
}

type Verdict = "met" | "not_met" | "unverifiable";
interface Assessment { requirement: string; verdict: Verdict; evidence: string; severity?: Severity }

const ASSESS_TOOL = {
  name: "assess_requirements",
  description: "Judge each acceptance criterion against the observed pages and findings. Never invent behavior not in the input.",
  input_schema: {
    type: "object" as const,
    properties: {
      assessments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requirement: { type: "string", description: "The criterion being judged, copied verbatim." },
            verdict: { type: "string", enum: ["met", "not_met", "unverifiable"] },
            evidence: { type: "string", description: "Which page/finding supports this verdict, or why it can't be checked from the outside." },
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "For not_met: business impact of the gap." },
          },
          required: ["requirement", "verdict", "evidence"],
        },
      },
    },
    required: ["assessments"],
  },
};

/**
 * Requirement-validation agent (Plan-v5 R1) — acceptance testing, the biggest
 * gap the GPT review named. Given the project's stated acceptance criteria, it
 * asks the model to judge each one against what the run actually observed
 * (discovered pages + this run's findings) as met / not_met / unverifiable.
 * Black-box safe: it only reasons over observed artifacts and is told not to
 * invent behavior. `not_met` → high bug (the app fails a stated requirement);
 * `unverifiable` → info (needs a journey or manual check). Returns tokens used.
 */
export async function requirementsAgent(ctx: RunContext, project: Project, tokenBudget: number): Promise<number> {
  const reqs = parseRequirements(project.requirements);
  if (!reqs.length) { ctx.log(AGENT, "step", "No acceptance criteria defined — skipping."); return 0; }
  if (tokenBudget <= 0 || !aiAvailable()) { ctx.log(AGENT, "warn", "Skipped — needs AI (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) and a non-zero budget."); return 0; }

  const pages = listGraphNodes(project.id, "page").slice(0, MAX_PAGES)
    .map((n) => `- ${n.attrs.url as string} — "${n.label}"`);
  const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const evidence = listFindings(ctx.runId)
    .filter((f) => f.agent !== AGENT)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, MAX_EVIDENCE)
    .map((f) => `- [${f.severity}] ${f.title}${f.pageUrl ? ` @ ${f.pageUrl}` : ""}`);

  const site = ctx.siteProfile;
  const prompt = `You are running acceptance testing on a web app as a black-box QA engineer — you can only observe pages and test findings, not the database or backend.
${site ? `Site type: ${site.kind}${site.framework ? ` (${site.framework})` : ""}.` : ""}
Acceptance criteria to judge:
${reqs.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Pages discovered this run (highest risk first):
${pages.join("\n") || "(none)"}

Findings observed this run (severity-ranked):
${evidence.join("\n") || "(none)"}

Call assess_requirements once. For each criterion, return verdict met / not_met / unverifiable with evidence pointing at a specific page or finding. Use "unverifiable" honestly when the criterion needs backend visibility or a multi-step flow this run did not exercise — do NOT guess "met". For not_met, set severity by business impact. Do not invent pages or behavior not listed above.`;

  try {
    const result = await aiToolCall({
      maxTokens: Math.min(1500, tokenBudget),
      tool: { name: ASSESS_TOOL.name, description: ASSESS_TOOL.description, schema: ASSESS_TOOL.input_schema },
      text: prompt,
    });
    const assessments = ((result?.input as { assessments?: Assessment[] } | null)?.assessments ?? []).filter((a) => a && a.requirement);
    let notMet = 0, unver = 0;
    for (const a of assessments) {
      if (a.verdict === "not_met") {
        notMet++;
        ctx.finding({ agent: AGENT, severity: a.severity && a.severity !== "info" ? a.severity : "high", kind: "bug", source: "ai", confidence: 0.7,
          role: null, pageUrl: null, title: `Requirement not met: ${a.requirement.slice(0, 120)}`,
          detail: `The app does not appear to satisfy this acceptance criterion.\n\n${a.evidence}`, evidence: null });
      } else if (a.verdict === "unverifiable") {
        unver++;
        ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", source: "ai", confidence: 0.7,
          role: null, pageUrl: null, title: `Requirement not verifiable black-box: ${a.requirement.slice(0, 120)}`,
          detail: `Could not confirm from the outside. ${a.evidence}\n\nAdd a business journey that exercises it, or a test inbox / DB check if it lives in the backend.`, evidence: null });
      }
    }
    const met = assessments.length - notMet - unver;
    ctx.finding({ agent: AGENT, severity: notMet ? "info" : "info", kind: "improvement", source: "ai", confidence: 0.7, role: null, pageUrl: null,
      title: `Acceptance check: ${met}/${assessments.length} criteria met`,
      detail: `${reqs.length} criteria judged — ${met} met, ${notMet} not met, ${unver} unverifiable black-box.`, evidence: null });

    const tokens = result?.tokens ?? 0;
    ctx.log(AGENT, "pass", `Requirement validation — ${met} met / ${notMet} not met / ${unver} unverifiable, ${tokens} tokens (${aiProviderLabel()})`);
    return tokens;
  } catch (e) {
    ctx.log(AGENT, "warn", `Requirement validation failed: ${String(e).slice(0, 200)}`);
    return 0;
  }
}
