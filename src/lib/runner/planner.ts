import type { Project, RunMode, Mission } from "../types";
import { profilesForMode } from "./devices";
import { aiAvailable, aiProviderLabel } from "./ai";

const SAMPLE_BY_MODE: Record<RunMode, number> = { quick: 3, smart: 6, full: 12 };
// Cost guardrail (§5.1 budget.aiTokens) — a ceiling, not an expected-usage number.
// Quick is 0 so the AI reviewer is provably off, not just usually-off-by-convention.
export const AI_BUDGET_BY_MODE: Record<RunMode, number> = { quick: 0, smart: 20_000, full: 60_000 };

const DETERMINISTIC_AGENTS = ["login", "crawler", "site-classifier", "route-health", "api-mapper", "api-validation", "analytics", "interaction", "page-expectations", "form-validation", "data-integrity", "ui-audit", "visual", "a11y", "perf", "security", "seo", "root-cause", "regression"];

/**
 * Heuristic Mission Planner (Plan-v2 §3.1) — no LLM required. Scopes a run by
 * mode instead of always "running everything": sample size scales with mode,
 * AI review only switches on for smart/full (and only if a key is configured),
 * and the permissions matrix only makes sense with 2+ roles. An AI-driven
 * planner (prompt → scoped subset of the graph) is real Plan-v2 scope but is
 * deferred — this ships Phase 1's explicit "heuristic fallback" first.
 */
export function planMission(project: Project, mode: RunMode): Mission {
  const agents = [...DETERMINISTIC_AGENTS];
  if (project.roles.length > 1) agents.push("permissions");
  if (project.registerPath) agents.push("register");
  if (mode === "full" && project.envTag !== "production") agents.push("crud");
  if (mode === "full") agents.push("resilience", "chaos", "memory-leak"); // fault injection + browser chaos + leak probe (P8/P10/R18)
  if (project.uploadFilePath && project.envTag !== "production") agents.push("file-upload"); // R5
  if (project.testInboxUrl && project.roles.length) agents.push("email-flows"); // R9

  const useAI = mode !== "quick" && aiAvailable();
  if (useAI) {
    if (project.journeys?.length) agents.push("journey"); // AI business-flow engine (P5)
    if (project.requirements?.trim()) agents.push("requirements"); // acceptance testing (Plan-v5 R1)
    if (mode === "full") agents.push("explorer"); // AI free-roam explorer (P5.7)
    agents.push("page-judge", "ai-reviewer", "senior-review"); // senior-review is the P6 sign-off
  }
  const aiTokenBudget = useAI ? AI_BUDGET_BY_MODE[mode] : 0;

  const profiles = profilesForMode(mode).map((p) => p.name);

  const reasons: string[] = [`${mode} mode`, `sampling ${SAMPLE_BY_MODE[mode]} page(s)/agent/role`, `${profiles.length} device profile(s): ${profiles.join(", ")}`];
  if (project.roles.length > 1) reasons.push(`${project.roles.length} roles → permission matrix enabled`);
  reasons.push(useAI ? `AI layer enabled via ${aiProviderLabel()} (budget ${aiTokenBudget.toLocaleString()} tokens)` : mode === "quick" ? "AI layer off (quick mode)" : "AI layer off (no ANTHROPIC_API_KEY / OPENROUTER_API_KEY)");

  return { agents, useAI, sampleSize: SAMPLE_BY_MODE[mode], profiles, aiTokenBudget, reason: reasons.join("; ") };
}
