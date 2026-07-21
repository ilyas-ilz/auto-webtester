import fs from "fs";
import path from "path";
import type { BrowserContext } from "playwright";
import { RunContext, scrollToBottom } from "../context";
import type { RoleCred } from "../../types";

const AGENT = "visual";
const BASELINE_ROOT = path.join(process.cwd(), "public", "baselines");

function safeName(input: string): string {
  return input.replace(/[^a-z0-9-]/gi, "_").slice(0, 80) || "root";
}

/** Pure baseline-compare decision — exported so the self-test can exercise it without a browser. */
export function diffBaseline(existing: Buffer | null, current: Buffer): "baselined" | "unchanged" | "changed" {
  if (!existing) return "baselined";
  return existing.equals(current) ? "unchanged" : "changed";
}

/**
 * Visual Regression Engineer (Plan-v2 §4 V11). Full-page-screenshot-diffs each
 * sampled page against a per-project/per-profile baseline on disk, plus
 * broken-image and cumulative-layout-shift checks. First sighting of a page
 * just records the baseline (nothing to compare against yet).
 *
 * ponytail: diff is a raw byte-compare, not a perceptual/pixel diff — it flags
 * "something changed," not where or how much. Add pixelmatch if false
 * positives from dynamic content (timestamps, ads, carousels) get noisy.
 * Also auto-accepts the new screenshot as the baseline after flagging a diff
 * (no approve/reject UI yet), so a real regression is reported once, not on
 * every subsequent run — add manual baseline approval if that's a problem.
 */
export async function visualAgent(
  ctx: RunContext,
  browserCtx: BrowserContext,
  projectId: string,
  role: RoleCred,
  sample: number,
  profileLabel = ""
): Promise<void> {
  const tag = (title: string) => (profileLabel ? `[${profileLabel}] ${title}` : title);
  const profileDir = path.join(BASELINE_ROOT, projectId, safeName(profileLabel || "default"));
  fs.mkdirSync(profileDir, { recursive: true });

  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  let baselined = 0;
  let changed = 0;
  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await scrollToBottom(page);
      await page.waitForTimeout(200);

      const current = await page.screenshot({ fullPage: true });
      const brokenImages = await page.evaluate(
        () => Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length
      );
      const cls = await page.evaluate(() => {
        const entries = performance.getEntriesByType("layout-shift") as unknown as Array<{ value: number; hadRecentInput: boolean }>;
        return entries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : e.value), 0);
      });

      if (brokenImages > 0) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`${brokenImages} broken image(s)`), detail: "One or more <img> elements failed to load (naturalWidth is 0).", evidence: null });
      }
      if (cls > 0.25) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`High cumulative layout shift (CLS ${cls.toFixed(2)})`), detail: "CLS above 0.25 is considered poor by Core Web Vitals.", evidence: null });
      }

      const file = path.join(profileDir, `${safeName(new URL(url).pathname)}.png`);
      const status = diffBaseline(fs.existsSync(file) ? fs.readFileSync(file) : null, current);
      if (status === "baselined") {
        fs.writeFileSync(file, current);
        baselined++;
      } else if (status === "changed") {
        changed++;
        const shot = await ctx.screenshot(page, `${role.name}-visual-diff-${safeName(new URL(url).pathname)}`);
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: tag("Visual change detected vs baseline"),
          detail: `Full-page screenshot differs from the stored baseline (${path.relative(process.cwd(), file)}). Could be a real layout regression or expected content change (dynamic data, copy edit).`,
          evidence: shot });
        fs.writeFileSync(file, current);
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `visual check failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Visual regression complete (${urls.length} pages, ${baselined} baselined, ${changed} changed, ${role.name})${profileLabel ? ` on ${profileLabel}` : ""}`);
}
