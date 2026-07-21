import type { RunContext } from "./context";

// Resilience wrapper (Plan-v2 §3.5). Senior testers don't quit on the first
// error; neither does the runner. Runs an agent, retries once on throw, then
// reports-and-continues (returns null) instead of aborting the whole role.
// ponytail: retry-once + continue covers transient nav/timeout flakes. Add
// reload / re-auth / selector-fallback rungs here if real flakiness demands it.
export async function withRecovery<T>(
  ctx: Pick<RunContext, "log" | "agentsRan" | "findingCounts">,
  agent: string,
  fn: () => Promise<T>
): Promise<T | null> {
  ctx.agentsRan.add(agent);
  const startedAt = Date.now();
  const findingsBefore = ctx.findingCounts.get(agent) ?? 0;
  ctx.log(agent, "agent-start", `${agent} started`);
  const done = (failed: boolean): void => {
    const durationMs = Date.now() - startedAt;
    const findings = (ctx.findingCounts.get(agent) ?? 0) - findingsBefore;
    ctx.log(agent, "agent-done", `${agent} ${failed ? "failed" : "finished"}`, { durationMs, findings, failed });
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fn();
      done(false);
      return result;
    } catch (e) {
      const last = attempt === 2;
      ctx.log(agent, "warn", `${last ? "failed after retry" : "errored, retrying"}: ${String(e).slice(0, 160)}`);
      if (last) {
        done(true);
        return null;
      }
    }
  }
  return null;
}
