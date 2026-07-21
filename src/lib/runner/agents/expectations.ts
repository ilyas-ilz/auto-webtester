import type { BrowserContext } from "playwright";
import type { RoleCred } from "../../types";
import { RunContext, scrollToBottom } from "../context";
import { urlTemplate } from "./crawler";

const AGENT = "page-expectations";

export type PageType = "landing" | "list" | "detail" | "article" | "search" | "form" | "error" | "unknown";

export interface PageFeatures {
  path: string; // pathname only
  templated: boolean; // URL has :n/:id segments → one of many siblings
  mainTextLen: number;
  repeatedGroups: number; // largest count of same-class sibling elements
  hasArticle: boolean;
  hasSearchInput: boolean;
  hasPrevNext: boolean;
  formCount: number;
  looksError: boolean;
}

/**
 * Deterministic page-type inference — "what is this page?" from URL shape and
 * DOM structure alone, no AI. Order matters: first match wins. Exported pure
 * so selftest.ts can pin the rules.
 */
export function inferPageType(f: PageFeatures): PageType {
  if (f.looksError) return "error";
  if (f.hasSearchInput && /search|find|query/i.test(f.path)) return "search";
  if (f.templated && f.hasArticle) return "article";
  if (f.templated) return "detail";
  if (f.repeatedGroups >= 6) return "list";
  if (f.hasArticle && f.mainTextLen > 800) return "article";
  if (f.formCount > 0 && f.mainTextLen < 600) return "form";
  if (f.path === "/" || f.path === "") return "landing";
  return "unknown";
}

/**
 * Page-expectations agent: the deterministic approximation of "a human looks
 * at each page and checks it does its job". For each sampled page it infers
 * the page type, then verifies type-specific invariants:
 *  - every page: renders actual content (catches blank client-side crashes)
 *  - detail/article pages: prev/next navigation really navigates
 *  - search pages: typing a query and submitting visibly changes the page
 * Finally it emits a site map — every URL template with its inferred type —
 * which is the "what pages are in it" answer in the report.
 */
export async function expectationsAgent(ctx: RunContext, browserCtx: BrowserContext, role: RoleCred, sampleSize: number): Promise<void> {
  const pages = ctx.sampleFor(role.name, Math.max(sampleSize, 6), AGENT);
  if (!pages.length) {
    ctx.log(AGENT, "warn", `No crawled pages to check for ${role.name}`);
    return;
  }

  const typeByTemplate = new Map<string, PageType>();

  for (const crawled of pages) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(crawled.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await scrollToBottom(page).catch(() => {}); // lazy content counts toward "does this page render anything"

      const raw = await page.evaluate(() => {
        const main = document.querySelector("main, [role='main'], #content, .content") ?? document.body;
        const text = (main?.textContent ?? "").replace(/\s+/g, " ").trim();
        // Largest group of same-class siblings = repeated structure = a list/grid.
        let repeated = 0;
        for (const parent of Array.from(document.querySelectorAll("ul, ol, tbody, [class]")).slice(0, 400)) {
          const byClass = new Map<string, number>();
          for (const child of Array.from(parent.children)) {
            const key = child.tagName + "." + child.className;
            byClass.set(key, (byClass.get(key) ?? 0) + 1);
          }
          for (const n of byClass.values()) if (n > repeated) repeated = n;
        }
        const bodyStart = (document.body?.innerText ?? "").slice(0, 2000).toLowerCase();
        return {
          mainTextLen: text.length,
          repeatedGroups: repeated,
          hasArticle: !!document.querySelector("article, [itemtype*='Article']"),
          hasSearchInput: !!document.querySelector("input[type='search'], input[name*='search' i], input[placeholder*='search' i]"),
          hasPrevNext: !!document.querySelector("a[rel='prev'], a[rel='next'], [class*='prev' i] a, [class*='next' i] a, a[class*='prev' i], a[class*='next' i]"),
          formCount: document.forms.length,
          looksError: /(^|\s)(404|not found|page doesn.t exist|something went wrong)(\s|$)/.test(bodyStart) && text.length < 600,
        };
      });

      const url = new URL(crawled.url);
      const tpl = urlTemplate(crawled.url);
      const f: PageFeatures = { ...raw, path: url.pathname, templated: /:(n|id)(\/|$)/.test(tpl) };
      const type = inferPageType(f);
      if (!typeByTemplate.has(tpl)) typeByTemplate.set(tpl, type);
      ctx.pageTypes.set(crawled.url, type); // page-judge picks one representative per type
      ctx.log(AGENT, "step", `${url.pathname} → ${type} (${f.mainTextLen} chars, ${f.repeatedGroups} repeated items)`);

      // Invariant 1 — every page must render real content. HTTP 200 with an
      // empty main is the classic silent client-side crash.
      if (f.mainTextLen < 40) {
        ctx.finding({
          agent: AGENT, severity: "high", role: role.name, pageUrl: crawled.url,
          title: "Page renders almost no content",
          detail: `HTTP ${crawled.status} but the main content area has only ${f.mainTextLen} characters of text. Likely a client-side render failure, an empty state with no message, or a JS crash.`,
          evidence: await ctx.screenshot(page, "empty-page"),
        });
      }

      // Invariant 2 — detail pages with prev/next must actually navigate.
      if ((type === "detail" || type === "article") && f.hasPrevNext) {
        const nextLink = page.locator("a[rel='next'], a[class*='next' i], [class*='next' i] a").first();
        const before = page.url();
        try {
          await nextLink.click({ timeout: 3000 });
          await page.waitForTimeout(800);
          if (page.url() === before) {
            ctx.finding({
              agent: AGENT, severity: "medium", confidence: 0.7, role: role.name, pageUrl: crawled.url,
              title: "Next-page navigation does not navigate",
              detail: "This detail page has a next/prev control; clicking 'next' changed nothing (same URL, no SPA route change).",
              evidence: await ctx.screenshot(page, "next-nav-dead"),
            });
          } else {
            ctx.log(AGENT, "pass", `prev/next navigation works on ${url.pathname} → ${new URL(page.url()).pathname}`);
          }
        } catch { /* control not clickable right now — skip, interaction agent covers dead controls */ }
      }

      // Invariant 3 — a search box must react to a query (GET search is read-only).
      if (f.hasSearchInput) {
        try {
          const box = page.locator("input[type='search'], input[name*='search' i], input[placeholder*='search' i]").first();
          const beforeLen = raw.mainTextLen;
          const beforeUrl = page.url();
          await box.fill("test", { timeout: 3000 });
          await box.press("Enter");
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(500);
          const afterLen = await page.evaluate(() => ((document.querySelector("main, [role='main'], #content, .content") ?? document.body)?.textContent ?? "").replace(/\s+/g, " ").trim().length);
          if (page.url() === beforeUrl && Math.abs(afterLen - beforeLen) < 20) {
            ctx.finding({
              agent: AGENT, severity: "medium", confidence: 0.7, role: role.name, pageUrl: crawled.url,
              title: "Search does not respond to a query",
              detail: `Typed "test" into the search box and pressed Enter — no navigation and no visible result change.`,
              evidence: await ctx.screenshot(page, "search-dead"),
            });
          } else {
            ctx.log(AGENT, "pass", `Search reacts to a query on ${url.pathname}`);
          }
        } catch { /* search box not interactable — skip */ }
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `Check failed on ${crawled.url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  // Site map: the "what pages are in it" answer, grouped by template.
  const summary = Array.from(typeByTemplate.entries())
    .map(([tpl, type]) => `${type}: ${tpl.replace(/^https?:\/\/[^/]+/, "") || "/"}`)
    .sort()
    .join("\n");
  ctx.finding({
    agent: AGENT, severity: "info", kind: "improvement", role: role.name, pageUrl: null,
    title: `Site map — ${typeByTemplate.size} page type(s) identified for ${role.name}`,
    detail: summary,
    evidence: null,
  });
  ctx.log(AGENT, "pass", `Checked ${pages.length} page(s) for ${role.name} against per-type expectations`);
}
