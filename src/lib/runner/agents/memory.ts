import type { BrowserContext } from "playwright";
import type { RoleCred } from "../../types";
import { RunContext } from "../context";
import { profileIsChromium } from "../devices";

const AGENT = "memory-leak";
const NAVIGATIONS = 8; // repeated loads to expose accumulation
const HEAP_GROWTH_FACTOR = 1.8; // final heap ≥ 1.8× the settled baseline → suspicious
const NODE_GROWTH_FACTOR = 1.5; // final live DOM node count ≥ 1.5× baseline → suspicious

export interface MemReading { heap: number; nodes: number }

/**
 * Leak classifier (Plan-v5 R18). Pure — selftested. A healthy SPA settles: heap
 * and DOM-node count wobble around a plateau after a few navigations. A leak
 * grows roughly monotonically. We compare the last reading to the *second*
 * reading (index 1 = after warm-up, so first-load allocations aren't counted as
 * a leak) and require both sustained growth AND a final value above the factor,
 * so GC noise on a single sample doesn't trigger it.
 */
export function classifyLeak(readings: MemReading[]): { leaking: boolean; reason: string } {
  if (readings.length < 4) return { leaking: false, reason: "too few samples" };
  const base = readings[1]; // after warm-up
  const last = readings[readings.length - 1];
  const mid = readings[Math.floor(readings.length / 2)];
  const grew = (a: number, b: number, c: number) => b >= a && c >= b; // base ≤ mid ≤ last (monotone-ish)

  if (base.heap > 0 && grew(base.heap, mid.heap, last.heap) && last.heap >= base.heap * HEAP_GROWTH_FACTOR) {
    return { leaking: true, reason: `JS heap grew from ${(base.heap / 1e6).toFixed(1)}MB to ${(last.heap / 1e6).toFixed(1)}MB across ${readings.length} navigations without settling` };
  }
  if (grew(base.nodes, mid.nodes, last.nodes) && last.nodes >= base.nodes * NODE_GROWTH_FACTOR) {
    return { leaking: true, reason: `Live DOM node count grew from ${base.nodes} to ${last.nodes} across ${readings.length} navigations (detached nodes likely retained)` };
  }
  return { leaking: false, reason: "heap and DOM node count stayed within bounds" };
}

/**
 * Memory-leak agent (Plan-v5 R18) — full mode only, Chromium only (needs
 * `performance.memory`). Repeatedly navigates the single riskiest page and
 * samples JS heap + live DOM node count; a sustained climb across navigations
 * → medium finding. Read-only. Cheap: one page, N reloads.
 */
export async function memoryLeakAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, profileName: string): Promise<void> {
  if (!profileIsChromium(profileName)) { ctx.log(AGENT, "step", `Skipped on ${profileName} — needs Chromium's performance.memory.`); return; }
  const target = ctx.sampleFor(role.name, 1, AGENT)[0];
  if (!target) { ctx.log(AGENT, "warn", `No page to probe for ${role.name}.`); return; }

  const page = await browserCtx.newPage();
  const readings: MemReading[] = [];
  try {
    for (let i = 0; i < NAVIGATIONS; i++) {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => ({
        heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
        nodes: document.getElementsByTagName("*").length,
      })).catch(() => ({ heap: 0, nodes: 0 }));
      readings.push(r);
    }
    const verdict = classifyLeak(readings);
    if (verdict.leaking) {
      ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: target.url,
        title: "Possible memory leak on repeated navigation",
        detail: `${verdict.reason}. Repeatedly visiting this page accumulates memory — over a long session it can slow or crash the tab. Common causes: event listeners/timers not cleaned up, growing caches, detached DOM held by closures.`,
        evidence: await ctx.screenshot(page, "memory-leak") });
    }
    ctx.log(AGENT, "pass", `Memory probe on ${target.url}: ${verdict.leaking ? "LEAK — " : "ok — "}${verdict.reason}`);
  } catch (e) {
    ctx.log(AGENT, "warn", `Memory probe failed: ${String(e).slice(0, 160)}`);
  } finally {
    await page.close();
  }
}
