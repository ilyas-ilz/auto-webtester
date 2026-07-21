import type { BrowserContext, Page } from "playwright";
import type { RoleCred } from "../../types";
import { RunContext, scrollToBottom, type CrawledPage } from "../context";
import { UNSAFE, urlTemplate } from "./crawler";
import { recordPageNode } from "../graph";

const AGENT = "interaction";
const MAX_ELEMENTS_PER_PAGE = 12;
const SETTLE_MS = 700;
const MAX_ADOPTED = 8; // ponytail: cap on click-discovered routes per role — raise if button-nav sites still feel shallow

/**
 * Gate for adopting a click-discovered URL into the tested page set: same
 * origin, not already known, not destructive, ≤2 representatives per URL
 * template (mirrors the crawler's sampling so 114 surahs ≠ 114 adoptions).
 * Mutates perTemplate on accept.
 */
export function shouldAdoptRoute(url: string, origin: string, known: Set<string>, perTemplate: Map<string, number>): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== origin || known.has(url) || UNSAFE.test(url)) return false;
  const tpl = urlTemplate(url);
  const n = perTemplate.get(tpl) ?? 0;
  if (n >= 2) return false;
  perTemplate.set(tpl, n + 1);
  return true;
}

// Clickable things the link-crawler can't see: buttons, ARIA widgets, onclick
// handlers. Submit buttons are excluded — form-validation owns form submits.
const CLICKABLE = 'button:not([type="submit"]), [role="button"], [role="tab"], [role="menuitem"], summary, [onclick]:not(a):not(input)';

interface MediaResult {
  src: string;
  tag: string;
  playError: string | null;
  currentTime: number;
  paused: boolean;
  networkState: number; // 3 = NETWORK_NO_SOURCE
}

/** Mute + play each <audio>/<video> in-page and report whether time actually advances. */
async function probeMedia(page: Page): Promise<MediaResult[]> {
  return page.evaluate(async () => {
    const els = Array.from(document.querySelectorAll("audio, video")) as HTMLMediaElement[];
    const out: { src: string; tag: string; playError: string | null; currentTime: number; paused: boolean; networkState: number }[] = [];
    for (const el of els.slice(0, 3)) {
      const src = el.currentSrc || el.src || (el.querySelector("source") as HTMLSourceElement | null)?.src || "";
      el.muted = true;
      let playError: string | null = null;
      try { await el.play(); } catch (e) { playError = String(e).slice(0, 200); }
      await new Promise((r) => setTimeout(r, 1500));
      out.push({ src, tag: el.tagName.toLowerCase(), playError, currentTime: el.currentTime, paused: el.paused, networkState: el.networkState });
      try { el.pause(); } catch { /* already stopped */ }
    }
    return out;
  });
}

/**
 * Interaction explorer (fills the "crawler only sees <a href>" gap). On a
 * sample of crawled pages it clicks visible non-link controls — menu toggles,
 * tabs, accordions, custom players — and watches what happens: SPA navigations
 * get reported as discovered routes, clicks that error get flagged, clicks
 * that visibly do nothing get flagged as suspect dead controls. Separately it
 * plays every <audio>/<video> element and verifies playback actually advances.
 * Read-only in spirit: destructive-looking labels are skipped via UNSAFE.
 *
 * Discovered routes are ADOPTED into ctx.pages (button-nav SPAs expose no
 * <a href>, so the crawler alone finds almost nothing) and queued here so
 * their own media/controls get probed too — run this before the agents that
 * sample ctx.pages.
 */
export async function interactionAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sampleSize: number): Promise<void> {
  const pages = ctx.sampleFor(role.name, sampleSize, AGENT);
  if (!pages.length) {
    ctx.log(AGENT, "warn", `No crawled pages to explore for ${role.name}`);
    return;
  }

  let clicks = 0, deadControls = 0, routesFound = 0, mediaChecked = 0, explored = 0, adopted = 0;
  const known = new Set(ctx.pages.filter((p) => p.role === role.name).map((p) => p.url));
  const perTemplate = new Map<string, number>();
  const queue = [...pages];

  while (queue.length) {
    const crawled = queue.shift()!;
    explored++;
    const page = await browserCtx.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));

    try {
      await page.goto(crawled.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await scrollToBottom(page).catch(() => {}); // mount lazy-loaded controls/players below the fold before probing

      // --- media playback ---
      const media = await probeMedia(page).catch(() => [] as MediaResult[]);
      for (const m of media) {
        mediaChecked++;
        const label = m.src ? m.src.split("/").pop()!.slice(0, 60) : `<${m.tag}> (no src)`;
        if (m.networkState === 3 || (!m.src && m.playError)) {
          ctx.finding({
            agent: AGENT, severity: "high", role: role.name, pageUrl: crawled.url,
            title: `Media element has no playable source (${label})`,
            detail: `<${m.tag}> on this page reports NETWORK_NO_SOURCE — the player renders but nothing can play.${m.playError ? ` play() said: ${m.playError}` : ""}`,
            evidence: null,
          });
        } else if (m.playError && /NotAllowedError/i.test(m.playError)) {
          ctx.log(AGENT, "warn", `Autoplay blocked for ${label} on ${crawled.url} — cannot verify playback headlessly`);
        } else if (m.paused || m.currentTime === 0) {
          ctx.finding({
            agent: AGENT, severity: "medium", confidence: 0.7, role: role.name, pageUrl: crawled.url,
            title: `Media did not start playing (${label})`,
            detail: `Called play() on the <${m.tag}> element, waited 1.5s: currentTime=${m.currentTime.toFixed(2)}, paused=${m.paused}.${m.playError ? ` play() error: ${m.playError}` : " The source may be slow, broken, or gated on user interaction beyond a click."}`,
            evidence: null,
          });
        } else {
          ctx.log(AGENT, "pass", `Media plays: ${label} (t=${m.currentTime.toFixed(1)}s) on ${crawled.url}`);
        }
      }

      // --- click exploration ---
      const startUrl = page.url();
      const locators = await page.locator(CLICKABLE).all();
      ctx.coverage.controlsSeen += locators.length; // P4 coverage: interactive controls discovered
      let tried = 0;
      for (const el of locators) {
        if (tried >= MAX_ELEMENTS_PER_PAGE) break;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        const label = ((await el.textContent().catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "").trim().slice(0, 60);
        if (UNSAFE.test(label)) continue;
        tried++;

        const errBefore = consoleErrors.length;
        const nodesBefore = await page.evaluate(() => document.querySelectorAll("*").length).catch(() => 0);
        try {
          await el.click({ timeout: 3000 });
        } catch {
          continue; // covered by overlay / detached — not a finding, just unclickable right now
        }
        clicks++;
        ctx.status(AGENT, `Clicking "${label || "(unlabeled)"}" as ${role.name}`, { url: crawled.url });
        await page.waitForTimeout(SETTLE_MS);
        if (clicks <= 30) await ctx.screenshot(page, `${role.name}-click-${label || "control"}`, { role: role.name });

        const nowUrl = page.url();
        if (nowUrl !== startUrl) {
          if (new URL(nowUrl).origin === new URL(startUrl).origin) {
            routesFound++;
            const clean = nowUrl.split("#")[0];
            if (adopted < MAX_ADOPTED && shouldAdoptRoute(clean, new URL(startUrl).origin, known, perTemplate)) {
              adopted++;
              known.add(clean);
              const rec: CrawledPage = { url: clean, title: await page.title().catch(() => ""), role: role.name, status: 200, consoleErrors: [], failedRequests: [], screenshot: null };
              ctx.pages.push(rec);
              ctx.recordTested(clean, AGENT); // discovered by clicking — a light interaction touch (V4 coverage matrix)
              recordPageNode(ctx.projectId, ctx.runId, clean, rec.title);
              queue.push(rec); // its own media/controls get probed too
              ctx.log(AGENT, "step", `Click "${label || "(unlabeled)"}" discovered ${clean} — adopted into the tested page set`);
            } else {
              ctx.log(AGENT, "step", `Click "${label || "(unlabeled)"}" navigated to ${nowUrl}`);
            }
          }
          await page.goBack({ timeout: 10000 }).catch(() => {});
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          continue;
        }

        const nodesAfter = await page.evaluate(() => document.querySelectorAll("*").length).catch(() => nodesBefore);
        if (consoleErrors.length > errBefore) {
          ctx.finding({
            agent: AGENT, severity: "medium", role: role.name, pageUrl: crawled.url,
            title: `Clicking "${label || "(unlabeled control)"}" throws a JS error`,
            detail: consoleErrors.slice(errBefore).join("\n"),
            evidence: await ctx.screenshot(page, `click-error-${label || "control"}`),
          });
        } else if (Math.abs(nodesAfter - nodesBefore) < 2) {
          // ponytail: DOM-node-count delta as the "did anything happen" proxy;
          // misses pure style/canvas changes — upgrade to MutationObserver if noisy.
          deadControls++;
          ctx.finding({
            agent: AGENT, severity: "low", confidence: 0.5, kind: "improvement", role: role.name, pageUrl: crawled.url,
            title: `Control "${label || "(unlabeled)"}" appears to do nothing`,
            detail: `Clicked it and nothing observable happened: no navigation, no DOM change, no console output within ${SETTLE_MS}ms. Could be a dead button, or its effect is invisible to this probe (styling/audio-object/analytics).`,
            evidence: null,
          });
        }
        // Close anything the click opened so the next click isn't buried under it.
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `Exploration failed on ${crawled.url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  ctx.coverage.controlsClicked += clicks; // P4 coverage: controls actually exercised
  ctx.log(AGENT, "pass", `Explored ${explored} page(s) for ${role.name}: ${clicks} clicks, ${routesFound} click-only route(s) discovered (${adopted} adopted into page set), ${deadControls} suspect dead control(s), ${mediaChecked} media element(s) probed`);
}
