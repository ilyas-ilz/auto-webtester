import type { BrowserContext, Page } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext } from "../context";

const AGENT = "resilience";
const MAX_PAGES = 4; // fault injection multiplies page loads (pages × faults) — keep the sample tight

/**
 * "Ungraceful reaction" classifier (Plan-v4 P8.3). Pure — selftested. A resilient
 * app degrades to an error/offline state; an ungraceful one shows a blank page,
 * a raw stack trace, or a spinner that never resolves.
 */
export function classifyReaction(s: { bodyText: string; hadPageError: boolean; spinnerVisible: boolean }): { ungraceful: boolean; reason: string } {
  const text = s.bodyText.trim();
  if (s.hadPageError) return { ungraceful: true, reason: "an uncaught JS exception" };
  if (/(TypeError|ReferenceError|\bat \w+\.\w+|Cannot read propert|undefined is not|Unhandled)/.test(text)) return { ungraceful: true, reason: "a raw error / stack trace shown to the user" };
  if (text.length < 30 && s.spinnerVisible) return { ungraceful: true, reason: "a spinner stuck with no content" };
  if (text.length < 15) return { ungraceful: true, reason: "a blank / empty page" };
  return { ungraceful: false, reason: "handled — still shows content" };
}

interface Fault { name: string; label: string; contextOpts?: Record<string, unknown>; setup?: (c: BrowserContext) => Promise<void>; perPage?: (p: Page, c: BrowserContext) => Promise<void> }

const FAULTS: Fault[] = [
  { name: "offline", label: "the network is offline", setup: async (c) => { await c.setOffline(true); } },
  { name: "api-500", label: "API calls return 500", setup: async (c) => { await c.route("**/api/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" })); } },
  { name: "images-fail", label: "images fail to load", setup: async (c) => { await c.route(/\.(png|jpe?g|webp|svg|gif)(\?|$)/i, (r) => r.abort()); } },
  { name: "js-disabled", label: "JavaScript is disabled", contextOpts: { javaScriptEnabled: false } },
  { name: "slow-3g", label: "the connection is very slow", perPage: async (p, c) => { const cdp = await c.newCDPSession(p).catch(() => null); await cdp?.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024 }).catch(() => {}); } },
];

/**
 * Fault-injection / resilience agent (Plan-v4 P8) — a senior QA breaks the site
 * on purpose. Full mode only. Re-loads a small risk-ranked sample under one
 * injected fault at a time (all native Playwright: offline, API-500, image-abort,
 * slow-3G, JS-off) in a THROWAWAY context cloned from the role's session, so the
 * faults never leak into the shared session used by other agents. Read-only —
 * never mutates data; safe on any environment.
 */
export async function resilienceAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred, sampleSize: number): Promise<void> {
  const browser = browserCtx.browser();
  if (!browser) { ctx.log(AGENT, "warn", "No browser handle — skipped."); return; }
  const sample = ctx.sampleFor(role.name, Math.min(sampleSize, MAX_PAGES), AGENT);
  if (!sample.length) { ctx.log(AGENT, "warn", `No pages to stress for ${role.name}.`); return; }
  const storageState = await browserCtx.storageState();
  const baseOpts = { storageState, ignoreHTTPSErrors: project.envTag === "localhost" };

  let ungraceful = 0;

  // Recovery scenario (Plan-v5 R17): unlike the faults above (which check the
  // reaction *while* broken), this checks the app *recovers* once the network
  // returns — a page that goes blank offline and stays blank after reconnect is
  // a worse bug than one that shows an offline message.
  {
    const rctx = await browser.newContext(baseOpts);
    try {
      const target = sample[0];
      const page = await rctx.newPage();
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await rctx.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      await rctx.setOffline(false);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const recoveredText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).trim();
      if (recoveredText.length < 15) {
        ungraceful++;
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
          title: "Page does not recover after the network returns",
          detail: `Took ${target.url} offline, then back online and reloaded — the page is still blank/empty. It should re-fetch and render once connectivity is restored, not stay stuck. (Read-only.)`,
          evidence: await ctx.screenshot(page, "recovery-failed") });
      }
      await page.close();
    } catch (e) {
      ctx.log(AGENT, "warn", `Recovery scenario failed: ${String(e).slice(0, 160)}`);
    } finally {
      await rctx.close();
    }
  }

  for (const fault of FAULTS) {
    const fctx = await browser.newContext({ ...baseOpts, ...(fault.contextOpts ?? {}) });
    try {
      if (fault.setup) await fault.setup(fctx);
      for (const target of sample) {
        const page = await fctx.newPage();
        let hadPageError = false;
        page.on("pageerror", () => { hadPageError = true; });
        try {
          if (fault.perPage) await fault.perPage(page, fctx);
          await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: fault.name === "slow-3g" ? 15000 : 20000 });
          await page.waitForTimeout(1500);
        } catch { /* nav failure is itself a signal — bodyText will be empty → ungraceful */ }
        const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        const spinnerVisible = await page.locator('[role="progressbar"], [class*="spinner"], [class*="loading"]').first().isVisible().catch(() => false);
        const verdict = classifyReaction({ bodyText, hadPageError, spinnerVisible });
        if (verdict.ungraceful) {
          ungraceful++;
          const shot = await ctx.screenshot(page, `resilience-${fault.name}`);
          ctx.finding({
            agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
            title: `Page breaks ungracefully when ${fault.label}`,
            detail: `Re-loaded ${target.url} with a fault injected (${fault.name}) and the result was ${verdict.reason}. A resilient app should show an explicit error/offline/empty state instead. (Read-only fault — no data was changed.)`,
            evidence: shot,
          });
        }
        await page.close();
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `Fault ${fault.name} failed: ${String(e).slice(0, 160)}`);
    } finally {
      await fctx.close();
    }
  }
  ctx.log(AGENT, "pass", `Resilience pass done for ${role.name}: ${ungraceful} ungraceful reaction(s) across ${FAULTS.length} fault(s) × ${sample.length} page(s)`);
}
