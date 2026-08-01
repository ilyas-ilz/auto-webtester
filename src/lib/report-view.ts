// One shared derivation of "which agents ran / were skipped" (WEBTESTER-AUDIT P1-17).
// Used by BOTH the dashboard and the Markdown/PDF exporter so they can never
// contradict each other. Evidence beats stored lists: an agent in `agentsRan` ran,
// and an agent that produced a finding or emitted an agent-done event demonstrably
// ran too — whatever `agentsSkipped` was told at serialization time (stale reports,
// pre-fix producers, corrupt JSON).
import type { RunReport } from "./types";

export interface AgentView {
  ran: string[];
  skipped: { name: string; reason: string }[];
}

export function deriveAgentView(
  report: Pick<RunReport, "agentsRan" | "agentsSkipped">,
  findingAgents: Iterable<string>,
  eventRanAgents: Iterable<string> = [],
): AgentView {
  const ran = new Set(report.agentsRan);
  for (const a of eventRanAgents) ran.add(a);
  const withFindings = new Set(findingAgents);
  const skipped = (report.agentsSkipped ?? []).filter((s) => !ran.has(s.name) && !withFindings.has(s.name));
  for (const a of withFindings) ran.add(a);
  return { ran: [...ran], skipped };
}
