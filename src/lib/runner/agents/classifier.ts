import type { BrowserContext } from "playwright";
import type { Project, SiteProfile, SiteKind } from "../../types";
import { RunContext } from "../context";
import { urlTemplate } from "./crawler";

const AGENT = "site-classifier";

interface PageSignals {
  generator: string;
  framework: string | null;
  serviceWorker: boolean;
  forms: number;
  passwordInputs: number;
  anchors: number;
  buttons: number;
  media: number;
  articles: number;
  commerceHits: number;
}

/**
 * Site-type classifier (Wappalyzer-style fingerprinting, no dependency).
 * Answers "what kind of site is this?" from one page-load of signals plus what
 * the crawl already observed, so downstream agents and the report can reason
 * about a static brochure site differently from a logged-in SaaS dashboard.
 * Runs once per run, after the first role's crawl.
 */
export async function classifierAgent(ctx: RunContext, browserCtx: BrowserContext, project: Project): Promise<void> {
  const page = await browserCtx.newPage();
  let s: PageSignals;
  try {
    await page.goto(project.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    s = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const framework = w.__NEXT_DATA__ ? "next.js"
        : w.__NUXT__ ? "nuxt"
        : w.___gatsby ? "gatsby"
        : document.querySelector("[ng-version]") ? "angular"
        : document.querySelector("[data-v-app], #app[data-server-rendered]") ? "vue"
        : document.querySelector("#root, #__next, [data-reactroot]") ? "react"
        : null;
      const text = (document.body?.innerText ?? "").slice(0, 30000).toLowerCase();
      const commerceHits = ["add to cart", "checkout", "shopping cart", "my orders", "buy now"].filter((t) => text.includes(t)).length
        + (document.querySelector('[class*="cart"], [id*="cart"], [href*="checkout"]') ? 1 : 0);
      return {
        generator: (document.querySelector('meta[name="generator"]') as HTMLMetaElement | null)?.content ?? "",
        framework,
        serviceWorker: !!navigator.serviceWorker,
        forms: document.forms.length,
        passwordInputs: document.querySelectorAll('input[type="password"]').length,
        anchors: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        media: document.querySelectorAll("audio, video").length,
        articles: document.querySelectorAll("article, [itemtype*='Article']").length,
        commerceHits,
      };
    });
  } catch (e) {
    ctx.log(AGENT, "warn", `Could not load ${project.baseUrl} to classify: ${String(e).slice(0, 160)}`);
    return;
  } finally {
    await page.close();
  }

  // Crawl-derived signals: API-call volume and how templated the URL space is
  // (a content site is a few templates repeated many times).
  const pages = ctx.pages.length || 1;
  const apiRatio = ctx.apiCalls.length / pages;
  const templates = new Set(ctx.pages.map((p) => urlTemplate(p.url)));
  const templatedRatio = 1 - templates.size / pages;
  const hasAuth = project.roles.length > 0 || s.passwordInputs > 0
    || ctx.pages.some((p) => /login|signin|sign-in|account/i.test(p.url));

  const signals: string[] = [];
  if (s.generator) signals.push(`generator=${s.generator}`);
  if (s.framework) signals.push(`framework=${s.framework}`);
  if (hasAuth) signals.push("auth surface present");
  if (s.media) signals.push(`${s.media} media element(s)`);
  if (s.commerceHits) signals.push(`${s.commerceHits} commerce signal(s)`);
  if (apiRatio > 1) signals.push(`API-heavy (${ctx.apiCalls.length} calls / ${pages} pages)`);
  if (templatedRatio > 0.3) signals.push(`templated URLs (${templates.size} templates for ${pages} pages)`);
  signals.push(`${s.forms} form(s)`, `${s.anchors} link(s)`, `${s.buttons} button(s)`);

  // Ordered verdict — first match wins. ponytail: transparent heuristics over
  // an ML/AI classifier; the signals list in the report shows the "why".
  let kind: SiteKind;
  if (s.commerceHits >= 2) kind = "ecommerce";
  else if (hasAuth && apiRatio > 1) kind = "saas";
  else if (s.framework && apiRatio > 0.5) kind = "spa";
  else if (templatedRatio > 0.3 || s.articles > 0 || s.media > 0 || /wordpress|ghost|hugo|jekyll/i.test(s.generator)) kind = "content";
  else kind = "static";

  const profile: SiteProfile = {
    kind,
    framework: s.framework ?? (s.generator || null),
    hasAuth,
    hasMedia: s.media > 0,
    signals,
  };
  ctx.siteProfile = profile;

  const strategy: Record<SiteKind, string> = {
    static: "breadth crawl + link/asset health; auth and API agents will mostly no-op",
    content: "template sampling (one page represents its siblings), media playback and reader-flow checks matter most",
    spa: "route discovery via history API, interaction clicks matter more than link crawling",
    saas: "auth flows, forms, permissions and API surface are the core risk",
    ecommerce: "catalog templates + cart/checkout funnel are the core risk (writes stay off in read-only mode)",
  };
  ctx.log(AGENT, "pass", `Site classified as "${kind}" — ${signals.join("; ")}`);
  ctx.finding({
    agent: AGENT, severity: "info", kind: "improvement", role: null, pageUrl: project.baseUrl,
    title: `Site type: ${kind}${profile.framework ? ` (${profile.framework})` : ""}`,
    detail: `Signals: ${signals.join("; ")}.\nTest strategy: ${strategy[kind]}.`,
    evidence: null,
  });
}
