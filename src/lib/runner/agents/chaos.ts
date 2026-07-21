import type { BrowserContext, Page } from "playwright";
import type { RoleCred } from "../../types";
import { RunContext } from "../context";
import { UNSAFE } from "./crawler";

const AGENT = "chaos";
const MAX_PAGES = 4;
const OVERFLOW_PX = 4; // sub-pixel rounding tolerance before calling it a real horizontal overflow

/** Viewport/emulation conditions applied one at a time (P10.1). Exposed for selftest. */
export const CHAOS_CONDITIONS = ["mobile-320", "wide-1920", "dark-mode", "reduced-motion", "forced-colors"] as const;
type ChaosCondition = (typeof CHAOS_CONDITIONS)[number];

/** A control is safe to spam-click only if its label isn't destructive (P10.2). Pure — selftested. */
export function isSafeChaosControl(label: string): boolean {
  return !UNSAFE.test(label);
}

async function applyCondition(page: Page, cond: ChaosCondition): Promise<void> {
  if (cond === "mobile-320") await page.setViewportSize({ width: 320, height: 640 }).catch(() => {});
  else if (cond === "wide-1920") await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  else if (cond === "dark-mode") await page.emulateMedia({ colorScheme: "dark" }).catch(() => {});
  else if (cond === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  else if (cond === "forced-colors") await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
}

/**
 * Timing / browser chaos (Plan-v4 P10) — cheap conditions a normal run never
 * exercises. Full mode only. On a risk-ranked sample: (1) resize/emulate across
 * mobile↔wide, dark-mode, reduced-motion and forced-colors, flagging horizontal
 * overflow; (2) double-click and rapid-spam a few NON-destructive controls
 * watching for uncaught errors (missing double-submit guards). Read-only — only
 * clicks controls whose label passes the UNSAFE filter.
 */
export async function chaosAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sampleSize: number): Promise<void> {
  const sample = ctx.sampleFor(role.name, Math.min(sampleSize, MAX_PAGES), AGENT);
  if (!sample.length) { ctx.log(AGENT, "warn", `No pages to chaos-test for ${role.name}.`); return; }

  let overflows = 0, clickErrors = 0;
  for (const target of sample) {
    const page = await browserCtx.newPage();
    let hadError = false;
    page.on("pageerror", () => { hadError = true; });
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 });

      for (const cond of CHAOS_CONDITIONS) {
        await applyCondition(page, cond);
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
        if (overflow > OVERFLOW_PX) {
          overflows++;
          ctx.finding({
            agent: AGENT, severity: "low", role: role.name, pageUrl: target.url,
            title: `Layout overflows horizontally under "${cond}"`,
            detail: `At ${cond} the page is ${overflow}px wider than the viewport — horizontal scrollbar / clipped content. Check responsive breakpoints and fixed-width elements.`,
            evidence: await ctx.screenshot(page, `chaos-${cond}`),
          });
        }
      }
      await page.emulateMedia({ colorScheme: null, reducedMotion: null, forcedColors: null }).catch(() => {});
      await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

      // Interaction chaos: double/rapid-click a few safe controls.
      const controls = await page.locator('button:not([type="submit"]), [role="button"]').all();
      let spammed = 0;
      for (const el of controls) {
        if (spammed >= 3) break;
        const label = ((await el.textContent().catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "").trim().slice(0, 60);
        if (!isSafeChaosControl(label) || !(await el.isVisible().catch(() => false))) continue;
        spammed++;
        const errBefore = hadError;
        await el.click({ clickCount: 2, timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 1000 }).catch(() => {});
        await el.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(300);
        if (hadError && !errBefore) {
          clickErrors++;
          ctx.finding({
            agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
            title: `Rapid/double-click on "${label || "a control"}" throws`,
            detail: "Double-clicking and rapid-clicking this control raised an uncaught error — likely a missing debounce or double-submit guard.",
            evidence: await ctx.screenshot(page, "chaos-double-click"),
          });
        }
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `Chaos on ${target.url} failed: ${String(e).slice(0, 140)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Chaos pass done for ${role.name}: ${overflows} overflow(s), ${clickErrors} click-error(s)`);
}
