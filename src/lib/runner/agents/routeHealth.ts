import { RunContext } from "../context";
import type { RoleCred } from "../../types";

const AGENT = "route-health";

/**
 * Verification agent (Nav + Monitoring). Reads the crawl output and raises
 * findings for HTTP errors, missing titles, console errors, and failed
 * network requests — no re-navigation, so it is effectively free.
 */
export function routeHealthAgent(ctx: RunContext, role: RoleCred): void {
  const pages = ctx.pages.filter((p) => p.role === role.name);
  for (const p of pages) {
    if (p.status !== null && p.status >= 500) {
      ctx.finding({ agent: AGENT, severity: "high", role: role.name, pageUrl: p.url,
        title: `Server error ${p.status} on ${p.url}`, detail: `Route returned HTTP ${p.status}.`, evidence: p.screenshot });
    } else if (p.status !== null && p.status >= 400) {
      ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: p.url,
        title: `Broken route ${p.status} on ${p.url}`, detail: `Route returned HTTP ${p.status}.`, evidence: p.screenshot });
    }
    if (!p.title) {
      ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: p.url,
        title: "Page has no <title>", detail: "Missing document title hurts tabs, SEO, and screen-reader orientation.", evidence: p.screenshot });
    }
    if (p.consoleErrors.length) {
      ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: p.url,
        title: `${p.consoleErrors.length} console error(s) on ${p.url}`,
        detail: p.consoleErrors.slice(0, 5).join("\n"), evidence: p.screenshot });
    }
    const badReq = p.failedRequests.filter((r) => r.status === 0 || r.status >= 400);
    if (badReq.length) {
      ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: p.url,
        title: `${badReq.length} failed network request(s) on ${p.url}`,
        detail: badReq.slice(0, 6).map((r) => `${r.status || "ERR"} ${r.method} ${r.url}`).join("\n"), evidence: p.screenshot });
    }
  }
  ctx.log(AGENT, "pass", `Checked route health for ${pages.length} pages (${role.name})`);
}
