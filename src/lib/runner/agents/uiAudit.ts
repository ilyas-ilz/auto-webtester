import type { BrowserContext } from "playwright";
import { RunContext, scrollToBottom } from "../context";
import type { RoleCred } from "../../types";

const AGENT = "ui-audit";

/**
 * Given one design token sampled per page, return the pages that disagree with
 * the majority. Needs a clear majority (>50%) over ≥3 samples, else returns []
 * — with only 1-2 pages, or a tie, "odd one out" is meaningless. Pure so it can
 * be unit-tested (selftest.ts). Plan-v2 V11 "UI uniformity audit".
 */
export function findOutliers(entries: { url: string; value: string | null }[]): { url: string; value: string; majority: string }[] {
  const valid = entries.filter((e): e is { url: string; value: string } => e.value != null && e.value !== "");
  if (valid.length < 3) return [];
  const counts = new Map<string, number>();
  for (const e of valid) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
  let majority = "";
  let max = 0;
  for (const [v, n] of counts) if (n > max) { max = n; majority = v; }
  if (max <= valid.length / 2) return []; // no clear majority → not an outlier situation
  return valid.filter((e) => e.value !== majority).map((e) => ({ url: e.url, value: e.value, majority }));
}

interface PageTokens { url: string; bodyFont: string | null; primaryBtn: string | null; h1size: string | null }

/**
 * UI agent — STATIC audit only (no clicking; clicking arbitrary controls on a
 * real app can mutate/destroy data). Per page: scrolls the whole page first to
 * trigger lazy-loaded content (Plan-v2 §9), then flags dead links, horizontal
 * overflow (responsive breakage), and text that is clipped or spilling out of
 * its container ("card text outlaying"). Across pages it collects design tokens
 * (body font, primary button colour, H1 size) and flags the odd-one-out page
 * — a UI-uniformity check no single-page audit can do. Complements axe, which
 * covers labels/alt text.
 */
export async function uiAuditAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sample: number, profileLabel = ""): Promise<void> {
  const tag = (title: string) => (profileLabel ? `[${profileLabel}] ${title}` : title);
  const urls = ctx.sampleFor(role.name, sample, AGENT).map((p) => p.url);

  const tokens: PageTokens[] = [];

  for (const url of urls) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await scrollToBottom(page).catch(() => {}); // trigger lazy content before measuring

      const audit = await page.evaluate(() => {
        const deadLinks = Array.from(document.querySelectorAll("a[href]")).filter((a) => {
          const h = (a as HTMLAnchorElement).getAttribute("href") || "";
          return h === "#" || h.trim() === "" || h.startsWith("javascript:");
        }).length;
        const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

        // Text clipping / spill on leaf text elements (cards, cells, buttons,
        // labels). Only leaf nodes so a big container isn't blamed for a child.
        const clipped: { sel: string; text: string; how: string }[] = [];
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if (el.childElementCount > 0) continue;
          if (/^(script|style|noscript|svg|path|template|br)$/i.test(el.tagName)) continue;
          const text = (el.textContent || "").trim();
          if (text.length < 2) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const dw = el.scrollWidth - el.clientWidth;
          const dh = el.scrollHeight - el.clientHeight;
          const clipX = dw > 2 && (cs.overflowX === "hidden" || cs.overflowX === "clip") && cs.textOverflow !== "ellipsis";
          const spillX = dw > 2 && cs.overflowX === "visible" && cs.whiteSpace === "nowrap";
          const clipY = dh > 2 && (cs.overflowY === "hidden" || cs.overflowY === "clip");
          if (clipX || spillX || clipY) {
            const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
            const cls = typeof el.className === "string" && el.className.trim()
              ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
            clipped.push({ sel: `${el.tagName.toLowerCase()}${id}${cls}`, text: text.slice(0, 40), how: clipX ? "clipped (no ellipsis)" : spillX ? "spilling out" : "clipped vertically" });
            if (clipped.length >= 8) break;
          }
        }

        const bg: Record<string, number> = {};
        for (const b of Array.from(document.querySelectorAll('button, [role="button"], .btn'))) {
          const c = getComputedStyle(b).backgroundColor;
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") bg[c] = (bg[c] || 0) + 1;
        }
        let primaryBtn: string | null = null, best = 0;
        for (const [c, n] of Object.entries(bg)) if (n > best) { best = n; primaryBtn = c; }
        const h1 = document.querySelector("h1");
        return {
          deadLinks, overflow, clipped,
          bodyFont: getComputedStyle(document.body).fontFamily || null,
          primaryBtn,
          h1size: h1 ? getComputedStyle(h1).fontSize : null,
        };
      });

      tokens.push({ url, bodyFont: audit.bodyFont, primaryBtn: audit.primaryBtn, h1size: audit.h1size });

      // A full-page screenshot is only worth capturing (and storing) when there
      // is a layout issue on the page to show as evidence.
      const hasIssue = audit.overflow > 4 || audit.clipped.length > 0;
      const shot = hasIssue ? await ctx.screenshot(page, `ui-${new URL(url).pathname.replace(/\//g, "_") || "root"}`, { fullPage: true }) : null;

      if (audit.deadLinks > 0) {
        ctx.finding({ agent: AGENT, severity: "low", role: role.name, pageUrl: url,
          title: tag(`${audit.deadLinks} placeholder/dead link(s)`), detail: 'Links with href "#", empty, or javascript: have no real destination.', evidence: null });
      }
      if (audit.overflow > 4) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`Horizontal overflow (${audit.overflow}px)`), detail: "Page is wider than the viewport — likely responsive breakage.", evidence: shot });
      }
      if (audit.clipped.length > 0) {
        const samples = audit.clipped.map((c) => `• ${c.sel} — "${c.text}" (${c.how})`).join("\n");
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`${audit.clipped.length} element(s) with clipped/overflowing text`),
          detail: `Text is cut off or spilling out of its container (e.g. a card too small for its content):\n${samples}`, evidence: shot });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `ui-audit failed on ${url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  // UI-uniformity (V11): flag the page whose tokens disagree with the rest.
  // Only on the primary profile — mobile/other engines legitimately differ.
  if (!profileLabel) {
    const dims: { label: string; pick: (t: PageTokens) => string | null }[] = [
      { label: "body font", pick: (t) => t.bodyFont },
      { label: "primary button colour", pick: (t) => t.primaryBtn },
      { label: "H1 size", pick: (t) => t.h1size },
    ];
    for (const dim of dims) {
      const outliers = findOutliers(tokens.map((t) => ({ url: t.url, value: dim.pick(t) })));
      for (const o of outliers) {
        ctx.finding({ agent: AGENT, severity: "low", kind: "improvement", role: role.name, pageUrl: o.url,
          title: tag(`Inconsistent ${dim.label}`),
          detail: `This page uses ${dim.label} "${o.value}" while most other pages use "${o.majority}". Inconsistent design tokens make the UI feel unpolished.`, evidence: null });
      }
    }
  }

  ctx.log(AGENT, "pass", `UI audit complete (${urls.length} pages, ${role.name})${profileLabel ? ` on ${profileLabel}` : ""}`);
}
