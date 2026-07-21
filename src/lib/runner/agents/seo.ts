import type { BrowserContext } from "playwright";
import type { Project, RoleCred, Severity } from "../../types";
import { RunContext } from "../context";

const AGENT = "seo";

/** SEO/discoverability signals read from one page's DOM. All optional/counts — no browser types here so it stays pure-testable. */
export interface SeoSignals {
  title: string;
  metaDescription: string;
  canonical: string;
  hasViewport: boolean;
  htmlLang: string;
  h1Count: number;
  robotsNoindex: boolean;
  ogTitle: boolean;
  ogImage: boolean;
  jsonLdCount: number;
}

export interface SeoIssue { severity: Severity; kind: "bug" | "improvement"; title: string; detail: string }

/**
 * Pure SEO audit (Plan-v5 R2). Deterministic checks a search engine or social
 * scraper would run on a served page. `noindex on production` is the one real
 * bug (a page silently kept out of search); the rest are quality improvements,
 * so SEO never flips a run to "failed". Selftested.
 */
export function auditSeoTags(s: SeoSignals, isProduction: boolean): SeoIssue[] {
  const out: SeoIssue[] = [];
  const imp = (severity: Severity, title: string, detail: string): void => { out.push({ severity, kind: "improvement", title, detail }); };

  if (isProduction && s.robotsNoindex) {
    out.push({ severity: "medium", kind: "bug", title: "Page is set to noindex on production", detail: "A `<meta name=robots content=noindex>` (or X-Robots-Tag) keeps this page out of search results — often a staging tag left in production." });
  }
  if (!s.title.trim()) imp("medium", "Missing <title>", "No page title — search results and browser tabs have nothing to show.");
  else if (s.title.length > 65) imp("low", "Title is long for search results", `The <title> is ${s.title.length} chars; search engines truncate around 60.`);
  if (!s.metaDescription.trim()) imp("low", "Missing meta description", "No meta description — search engines auto-generate a snippet instead of your copy.");
  else if (s.metaDescription.length > 165) imp("low", "Meta description is long", `${s.metaDescription.length} chars; ~160 is the display limit.`);
  if (!s.canonical.trim()) imp("low", "No canonical URL", "Missing <link rel=canonical> — duplicate/parameterized URLs can split ranking signals.");
  if (!s.hasViewport) imp("medium", "No responsive viewport meta", "Missing <meta name=viewport> — mobile search ranking and rendering both suffer.");
  if (!s.htmlLang.trim()) imp("low", "No <html lang> attribute", "Missing document language — hurts SEO localization and screen-reader pronunciation.");
  if (s.h1Count === 0) imp("medium", "No <h1> heading", "The page has no top-level heading for search engines to key on.");
  else if (s.h1Count > 1) imp("low", `Multiple <h1> headings (${s.h1Count})`, "More than one <h1> dilutes the page's primary topic signal.");
  if (!s.ogTitle || !s.ogImage) imp("low", "Incomplete Open Graph tags", `Missing ${[!s.ogTitle && "og:title", !s.ogImage && "og:image"].filter(Boolean).join(" + ")} — link previews on social/chat will look bare.`);

  return out;
}

/**
 * SEO / discoverability agent (Plan-v5 R2) — deterministic, no AI. On a
 * risk-weighted sample it reads the tags a crawler/social-scraper reads and
 * flags missing/oversized ones; once per run it checks robots.txt + sitemap.xml
 * exist. Read-only. Findings are improvements (SEO is quality, not a functional
 * break) except a production `noindex`, which is a real "invisible to search" bug.
 */
export async function seoAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project, role: RoleCred, sampleSize: number, emitSiteLevel: boolean): Promise<void> {
  const isProd = project.envTag === "production";

  if (emitSiteLevel) {
    const origin = new URL(project.baseUrl).origin;
    for (const [file, label] of [["/robots.txt", "robots.txt"], ["/sitemap.xml", "sitemap.xml"]] as const) {
      const ok = await browserCtx.request.get(origin + file, { timeout: 10000 }).then((r) => r.ok()).catch(() => false);
      if (!ok) ctx.finding({ agent: AGENT, severity: "low", kind: "improvement", role: null, pageUrl: origin + file,
        title: `No ${label}`, detail: `${origin + file} did not return 200 — search engines rely on it to discover and crawl the site efficiently.`, evidence: null });
    }
  }

  const sample = ctx.sampleFor(role.name, sampleSize, AGENT);
  let flagged = 0;
  for (const target of sample) {
    const page = await browserCtx.newPage();
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const signals = await page.evaluate((): SeoSignals => {
        const attr = (sel: string, a: string) => (document.querySelector(sel)?.getAttribute(a) || "").trim();
        const robots = attr('meta[name="robots" i]', "content").toLowerCase();
        return {
          title: (document.title || "").trim(),
          metaDescription: attr('meta[name="description" i]', "content"),
          canonical: attr('link[rel="canonical" i]', "href"),
          hasViewport: !!document.querySelector('meta[name="viewport" i]'),
          htmlLang: (document.documentElement.getAttribute("lang") || "").trim(),
          h1Count: document.querySelectorAll("h1").length,
          robotsNoindex: /noindex/.test(robots),
          ogTitle: !!document.querySelector('meta[property="og:title" i]'),
          ogImage: !!document.querySelector('meta[property="og:image" i]'),
          jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
        };
      }).catch(() => null);
      if (!signals) continue;
      for (const issue of auditSeoTags(signals, isProd)) {
        flagged++;
        ctx.finding({ agent: AGENT, severity: issue.severity, kind: issue.kind, role: role.name, pageUrl: target.url,
          title: issue.title, detail: issue.detail, evidence: null });
      }
    } catch (e) {
      ctx.log(AGENT, "warn", `SEO check failed on ${target.url}: ${String(e).slice(0, 140)}`);
    } finally {
      await page.close();
    }
  }
  ctx.log(AGENT, "pass", `SEO scan done for ${role.name}: ${flagged} issue(s) across ${sample.length} page(s)`);
}
