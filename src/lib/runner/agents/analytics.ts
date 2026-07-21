import { RunContext } from "../context";
import type { SiteKind, Severity } from "../../types";

const AGENT = "analytics";

export interface AnalyticsIssue { severity: Severity; title: string; detail: string }

/**
 * Assess analytics/telemetry coverage (Plan-v5 R7). Pure — selftested. Black-box:
 * we can see which providers *fired* (beacon requests captured during the crawl),
 * not whether every event is correct. The one honest signal: a revenue-driven
 * site (ecommerce/saas) with **zero** analytics is almost certainly a mistake —
 * they can't see conversion or funnel drop-off. Content/static sites legitimately
 * run without it, so no finding there.
 */
export function assessAnalytics(providers: string[], siteKind: SiteKind | null): AnalyticsIssue[] {
  if (providers.length) return []; // something fires — reporting which is enough (logged, not a finding)
  if (siteKind === "ecommerce" || siteKind === "saas") {
    return [{ severity: "low", title: "No analytics/telemetry detected",
      detail: `This looks like a ${siteKind} site but no analytics beacon (GA, Meta Pixel, Segment, Mixpanel, Amplitude, PostHog, …) fired during the crawl. Conversion, funnel, and error tracking are likely missing — or blocked before they could send.` }];
  }
  return [];
}

/**
 * Analytics agent (Plan-v5 R7) — deterministic, no AI. Reports which telemetry
 * providers were seen firing during discovery (from `ctx.analyticsHits`, populated
 * by the crawler's network interception) and flags a revenue site with none.
 */
export function analyticsAgent(ctx: RunContext): void {
  const providers = [...ctx.analyticsHits];
  if (providers.length) {
    ctx.finding({ agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: null,
      title: `Analytics detected: ${providers.join(", ")}`,
      detail: `These telemetry providers fired during the crawl. (Black-box scope: presence is observable; per-event correctness is not — pair with a business journey if a specific conversion event must be verified.)`, evidence: null });
  }
  for (const i of assessAnalytics(providers, ctx.siteProfile?.kind ?? null)) {
    ctx.finding({ agent: AGENT, severity: i.severity, kind: "improvement", role: null, pageUrl: null, title: i.title, detail: i.detail, evidence: null });
  }
  ctx.log(AGENT, "pass", `Analytics scan: ${providers.length} provider(s) seen`);
}
