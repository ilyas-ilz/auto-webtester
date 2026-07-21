import { RunContext } from "../context";
import { graphSummary } from "../../db";

const AGENT = "api-mapper";

/**
 * Discovery agent (Plan-v2 D3). The crawler already intercepts same-origin
 * JSON/`/api/` responses and writes API graph nodes as it walks pages — this
 * just reports what accumulated. Kept a separate persona (not a separate
 * navigation pass) because re-crawling only to sniff network traffic already
 * captured would double the browser cost for zero new data.
 */
export function apiMapperAgent(ctx: RunContext, projectId: string): void {
  const { apis } = graphSummary(projectId);
  ctx.log(AGENT, "pass", `API surface: ${apis} endpoint(s) known in the graph (${ctx.apiCalls.length} calls this run)`);
}
