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
 * Baseline identity (WEBTESTER-AUDIT P1-7). Previously keyed by project + profile +
 * pathname only, so two roles seeing legitimately different views of the same route
 * overwrote each other's baseline and reported a change forever. Role and viewport
 * are part of what a screenshot IS, so they belong in the key. Pure — selftested.
 */
export function baselineKey(role: string, profileLabel: string, viewport: { width: number; height: number } | null, pathname: string): string {
  const vp = viewport ? `${viewport.width}x${viewport.height}` : "novp";
  return [safeName(role), safeName(profileLabel || "default"), vp, safeName(pathname)].join("__");
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
 *
 * P1-7 (WEBTESTER-AUDIT): the approved baseline is NEVER overwritten on a detected
 * change. The new render is written beside it as `<key>.candidate.png` and the
 * change stays reported every run until a human approves it (delete/replace the
 * approved file, or `npm run visual:approve`). Auto-accept meant a real regression
 * was reported exactly once and then silently became the new "correct".
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
      await ctx.observe(page, url, AGENT);
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
      // Core Web Vitals bands: good < 0.1, needs-improvement 0.1–0.25, poor > 0.25.
      // Only the "poor" band was reported before, so a visible post-load jump that
      // landed mid-band (content injected after paint) went unmentioned entirely.
      if (cls > 0.25) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`High cumulative layout shift (CLS ${cls.toFixed(2)})`), detail: "CLS above 0.25 is considered poor by Core Web Vitals — content visibly jumps after load.", evidence: null });
      } else if (cls > 0.1) {
        ctx.finding({ agent: AGENT, severity: "low", kind: "improvement", role: role.name, pageUrl: url,
          title: tag(`Noticeable cumulative layout shift (CLS ${cls.toFixed(2)})`),
          detail: "CLS between 0.1 and 0.25 is the Core Web Vitals \"needs improvement\" band: something is inserted or resized after first paint and pushes content around.", evidence: null });
      }

      const key = baselineKey(role.name, profileLabel, page.viewportSize(), new URL(url).pathname);
      const file = path.join(profileDir, `${key}.png`);
      const candidate = path.join(profileDir, `${key}.candidate.png`);
      const status = diffBaseline(fs.existsSync(file) ? fs.readFileSync(file) : null, current);
      if (status === "baselined") {
        fs.writeFileSync(file, current);
        baselined++;
      } else if (status === "changed") {
        changed++;
        const shot = await ctx.screenshot(page, `${role.name}-visual-diff-${safeName(new URL(url).pathname)}`);
        // P1-7: candidate written beside the approved baseline; approved file untouched.
        fs.writeFileSync(candidate, current);
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: tag("Visual change detected vs baseline — pending review"),
          detail: `Full-page screenshot differs from the approved baseline (${path.relative(process.cwd(), file)}). The new render was saved as a candidate (${path.relative(process.cwd(), candidate)}) and the approved baseline was NOT changed, so this keeps being reported until a human approves it (\`npm run visual:approve\`). Could be a real layout regression or an expected content change (dynamic data, copy edit).`,
          evidence: shot });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `visual check failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `Visual regression complete (${urls.length} pages, ${baselined} baselined, ${changed} changed, ${role.name})${profileLabel ? ` on ${profileLabel}` : ""}`);
}
