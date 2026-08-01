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

/** WCAG 2.5.8 (AA) asks for at least 24×24 CSS px of pointer target. */
export const MIN_TAP_PX = 24;

/**
 * Interactive elements whose hit area is below the guidance (bench u8). Pure so the
 * threshold is testable without a browser. Elements smaller than 4px in either
 * direction are treated as decorative/hidden rather than mis-sized taps.
 */
export function tooSmallTaps(targets: { sel: string; w: number; h: number }[], min = MIN_TAP_PX): { sel: string; w: number; h: number }[] {
  return targets.filter((t) => t.w >= 4 && t.h >= 4 && (t.w < min || t.h < min));
}

/**
 * Fraction of the SMALLER rect covered by the intersection. Two laid-out siblings
 * should not cover each other; a ratio above the threshold means content is sitting
 * on top of content (bench u9). Pure — selftested.
 */
export function overlapRatio(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller <= 0 ? 0 : inter / smaller;
}

export const OVERLAP_THRESHOLD = 0.25;

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
      await ctx.observe(page, url, AGENT);
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
        // Pointer targets (bench u8): every interactive element's rendered hit area.
        const taps: { sel: string; w: number; h: number }[] = [];
        for (const el of Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [onclick]'))) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
          const label = (el.textContent || "").trim().slice(0, 20);
          taps.push({ sel: `${el.tagName.toLowerCase()}${id}${label ? ` "${label}"` : ""}`, w: Math.round(r.width), h: Math.round(r.height) });
          if (taps.length >= 120) break;
        }

        // Overlapping siblings (bench u9): content covering content. Compared only
        // within the same parent, and only for elements that actually carry text, so
        // deliberate overlays (modals, dropdowns, sticky bars) are not blamed.
        const boxes: { sel: string; x: number; y: number; w: number; h: number; parent: string }[] = [];
        let pIdx = 0;
        for (const parent of Array.from(document.querySelectorAll("body *")).slice(0, 400)) {
          if (parent.childElementCount < 2) continue;
          const pk = `p${pIdx++}`;
          for (const el of Array.from(parent.children)) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed" || cs.position === "sticky") continue;
            if (!(el.textContent || "").trim()) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
            boxes.push({ sel: `${el.tagName.toLowerCase()}${id}`, x: r.left, y: r.top, w: r.width, h: r.height, parent: pk });
          }
        }

        const h1 = document.querySelector("h1");
        return {
          deadLinks, overflow, clipped, taps, boxes,
          bodyFont: getComputedStyle(document.body).fontFamily || null,
          primaryBtn,
          h1size: h1 ? getComputedStyle(h1).fontSize : null,
        };
      });

      // Content that vanishes at a phone width (bench u10). Measured by narrowing the
      // viewport on the SAME page — a per-breakpoint check a single-viewport audit
      // cannot do, and the reason "works on desktop" hides mobile-only holes.
      // Only reported on the primary (desktop) profile: a mobile profile is already
      // narrow, so the comparison would be meaningless there.
      let vanished: string[] = [];
      if (!profileLabel) {
        const original = page.viewportSize();
        try {
          const visibleText = () =>
            page.evaluate(() => {
              const out: string[] = [];
              for (const el of Array.from(document.querySelectorAll("body *"))) {
                if (el.childElementCount > 0) continue;
                const t = (el.textContent || "").trim();
                if (t.length < 8) continue;
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                if (cs.display === "none" || cs.visibility === "hidden" || (r.width === 0 && r.height === 0)) continue;
                out.push(t.slice(0, 60));
              }
              return out;
            });
          const wide = new Set(await visibleText());
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForTimeout(250);
          const narrow = new Set(await visibleText());
          vanished = [...wide].filter((t) => !narrow.has(t)).slice(0, 6);
        } catch { /* viewport change unsupported — skip the breakpoint check */ } finally {
          if (original) await page.setViewportSize(original).catch(() => {});
        }
      }

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

      // Pointer targets too small to hit reliably on a touch screen.
      const smallTaps = tooSmallTaps(audit.taps);
      if (smallTaps.length > 0) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`${smallTaps.length} tap target(s) smaller than ${MIN_TAP_PX}px`),
          detail: `WCAG 2.5.8 (AA) asks for at least ${MIN_TAP_PX}×${MIN_TAP_PX} CSS px of pointer target. These are smaller, so they are hard to hit on a phone:\n${smallTaps.slice(0, 8).map((t) => `• ${t.sel} — ${t.w}×${t.h}px`).join("\n")}`,
          evidence: shot, owasp: [] });
      }

      // Content sitting on top of content.
      const overlaps: string[] = [];
      for (let i = 0; i < audit.boxes.length && overlaps.length < 6; i++) {
        for (let j = i + 1; j < audit.boxes.length && overlaps.length < 6; j++) {
          const a = audit.boxes[i], b = audit.boxes[j];
          if (a.parent !== b.parent) continue;
          const ratio = overlapRatio(a, b);
          if (ratio > OVERLAP_THRESHOLD) overlaps.push(`• ${a.sel} and ${b.sel} overlap by ${Math.round(ratio * 100)}% of the smaller element`);
        }
      }
      if (overlaps.length > 0) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`${overlaps.length} pair(s) of overlapping elements`),
          detail: `Sibling elements are covering each other, so some content is unreadable or unclickable:\n${overlaps.join("\n")}`,
          evidence: shot });
      }

      // Content present on desktop and gone at phone width.
      if (vanished.length > 0) {
        ctx.finding({ agent: AGENT, severity: "medium", role: role.name, pageUrl: url,
          title: tag(`${vanished.length} block(s) of content hidden at 390px width`),
          detail: `This content is visible on desktop but disappears on a phone-width viewport, with no alternative shown — mobile users cannot reach it:\n${vanished.map((t) => `• "${t}"`).join("\n")}`,
          evidence: shot });
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
