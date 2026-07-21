import type { BrowserContext } from "playwright";
import { chromium } from "playwright";
import * as chromeLauncher from "chrome-launcher";
import { RunContext } from "../context";
import type { RoleCred, RunMode } from "../../types";

const AGENT = "perf";
const LH_MAX_PAGES = 3;
// Thresholds match Google's published Core Web Vitals "poor" cutoffs — a low
// noise floor on purpose, so a Lighthouse finding means something is actually bad.
const LH_PERF_SCORE_FLOOR = 50;
const LH_LCP_POOR_MS = 4000;
const LH_CLS_POOR = 0.25;

/**
 * Performance agent. Samples navigation timing (loadEventEnd, DOMContentLoaded)
 * per page and flags slow loads. Deterministic, zero LLM cost.
 * Full Lighthouse / Core Web Vitals (INP) is a later add — this is the cheap baseline.
 */
export async function perfAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sample: number, profileLabel = ""): Promise<void> {
  const tag = (title: string) => (profileLabel ? `[${profileLabel}] ${title}` : title);
  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      const timing = await page.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        return n ? { load: Math.round(n.loadEventEnd - n.startTime), dcl: Math.round(n.domContentLoadedEventEnd - n.startTime) } : null;
      });
      if (timing) {
        ctx.log(AGENT, "step", `${url} load=${timing.load}ms dcl=${timing.dcl}ms`);
        if (timing.load > 8000) {
          ctx.finding({ agent: AGENT, severity: "high", role: role.name, pageUrl: url,
            title: tag(`Very slow page load (${(timing.load / 1000).toFixed(1)}s)`), detail: `loadEventEnd at ${timing.load}ms.`, evidence: null });
        } else if (timing.load > 4000) {
          ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
            title: tag(`Slow page load (${(timing.load / 1000).toFixed(1)}s)`), detail: `loadEventEnd at ${timing.load}ms.`, evidence: null });
        }
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `perf failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Performance sampling complete (${urls.length} pages, ${role.name})${profileLabel ? ` on ${profileLabel}` : ""}`);
}

/**
 * Lighthouse pass (Plan-v6 V5) — the perf agent getting a better sensor, not a
 * new agent. Runs once per run (not per role/profile): Lighthouse audits are
 * expensive and role-agnostic, so one representative URL per known page type
 * (capped) is enough signal without paying for near-duplicate audits of
 * sibling pages. Smart/full only — too slow to justify in quick mode.
 * Launches its own headless Chrome via Playwright's already-installed
 * Chromium binary (chrome-launcher's `chromePath`) instead of requiring a
 * separate system Chrome install.
 */
export async function lighthouseAudit(ctx: RunContext, mode: RunMode): Promise<void> {
  if (mode === "quick") { ctx.log(AGENT, "warn", "Lighthouse runs in smart/full only — skipped."); return; }

  const byType = new Map<string, string>(); // page type → one representative url
  for (const p of ctx.pages) {
    const type = ctx.pageTypes.get(p.url) ?? "unknown";
    if (!byType.has(type)) byType.set(type, p.url);
  }
  const urls = [...byType.values()].slice(0, LH_MAX_PAGES);
  if (!urls.length) { ctx.log(AGENT, "warn", "No pages to Lighthouse-audit — skipped."); return; }

  // Dynamic import, not a static one: lighthouse ships an esbuild-bundled ESM
  // build that references its own `__name` keep-names helper — under tsx's
  // static-import transform (used by the CLI/selftest) that helper is dropped
  // and every call throws "ReferenceError: __name is not defined". A dynamic
  // import goes through Node's native ESM loader instead and works everywhere
  // (tsx CLI, selftest, and the Next.js app).
  const { default: lighthouse } = await import("lighthouse");

  let chrome: chromeLauncher.LaunchedChrome | null = null;
  try {
    chrome = await chromeLauncher.launch({
      chromePath: chromium.executablePath(),
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
    });
    for (const url of urls) {
      ctx.status(AGENT, `Lighthouse-auditing ${url}`, { url });
      try {
        const result = await lighthouse(url, {
          port: chrome.port,
          output: "json",
          onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
          logLevel: "silent",
        });
        const lhr = result?.lhr;
        if (!lhr) { ctx.log(AGENT, "warn", `Lighthouse returned no result for ${url}`); continue; }

        const scores = {
          performance: Math.round((lhr.categories.performance?.score ?? 0) * 100),
          accessibility: Math.round((lhr.categories.accessibility?.score ?? 0) * 100),
          bestPractices: Math.round((lhr.categories["best-practices"]?.score ?? 0) * 100),
          seo: Math.round((lhr.categories.seo?.score ?? 0) * 100),
        };
        const lcpMs = lhr.audits["largest-contentful-paint"]?.numericValue ?? null;
        const cls = lhr.audits["cumulative-layout-shift"]?.numericValue ?? null;
        const tbtMs = lhr.audits["total-blocking-time"]?.numericValue ?? null;
        ctx.lighthouse.push({ url, scores, lcpMs, cls, tbtMs });

        if (scores.performance < LH_PERF_SCORE_FLOOR) {
          ctx.finding({ agent: AGENT, severity: "high", role: null, pageUrl: url,
            title: `Lighthouse performance score is low (${scores.performance}/100)`,
            detail: `Performance ${scores.performance}, Accessibility ${scores.accessibility}, Best Practices ${scores.bestPractices}, SEO ${scores.seo}. LCP ${lcpMs ? `${(lcpMs / 1000).toFixed(1)}s` : "n/a"}, CLS ${cls ?? "n/a"}, TBT ${tbtMs ? `${Math.round(tbtMs)}ms` : "n/a"}.`,
            evidence: null });
        }
        if (lcpMs !== null && lcpMs > LH_LCP_POOR_MS) {
          ctx.finding({ agent: AGENT, severity: "medium", role: null, pageUrl: url,
            title: `Largest Contentful Paint is slow (${(lcpMs / 1000).toFixed(1)}s)`,
            detail: "Above 4s is classified 'poor' by Google's Core Web Vitals thresholds.", evidence: null });
        }
        if (cls !== null && cls > LH_CLS_POOR) {
          ctx.finding({ agent: AGENT, severity: "medium", role: null, pageUrl: url,
            title: `Cumulative Layout Shift is high (${cls.toFixed(2)})`,
            detail: "Above 0.25 is classified 'poor' by Google's Core Web Vitals thresholds.", evidence: null });
        }
        ctx.log(AGENT, "pass", `Lighthouse ${url} → perf ${scores.performance}, a11y ${scores.accessibility}, best-practices ${scores.bestPractices}, seo ${scores.seo}`);
      } catch (e) {
        ctx.log(AGENT, "warn", `Lighthouse failed on ${url}: ${String(e).slice(0, 160)}`);
      }
    }
  } catch (e) {
    ctx.log(AGENT, "warn", `Lighthouse Chrome launch failed: ${String(e).slice(0, 160)}`);
  } finally {
    // ponytail: chrome-launcher's kill() is synchronous and its temp-dir
    // cleanup races Windows file locks on "Account Web Data" (EBUSY) even
    // after a fully successful audit — scores are already pushed to
    // ctx.lighthouse by then, so a cleanup-only failure here must not fail
    // (and retry-duplicate) the whole audit.
    try { chrome?.kill(); } catch (e) { ctx.log(AGENT, "warn", `Chrome cleanup failed (harmless): ${String(e).slice(0, 160)}`); }
  }
}
