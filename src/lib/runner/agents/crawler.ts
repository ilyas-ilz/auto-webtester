import type { BrowserContext, Page } from "playwright";
import type { Project, RoleCred } from "../../types";
import { RunContext, type CrawledPage, scrollToBottom } from "../context";
import { recordPageNode, recordNavEdge, recordApiNode } from "../graph";
import { looksLoggedOut, reauth } from "./login";

const AGENT = "crawler";
const MAX_PAGES = 40;
const MAX_PER_TEMPLATE = 3; // /surah/2 and /surah/3 are the same template — test a few, not all 114
const MAX_PER_PARENT = 8; // slug children (/surah/al-fatiha …) collapse under their parent dir
const MAX_API_SAMPLES = 60; // cap on captured JSON response bodies (R4) — bounds memory on chatty SPAs

// Known analytics/telemetry beacon hosts (Plan-v5 R7). A request to any of these
// means the provider fired; the analytics agent reports what it saw. Pure host
// match — exported for selftest.
const ANALYTICS_HOSTS: [RegExp, string][] = [
  [/google-analytics\.com|analytics\.google\.com|googletagmanager\.com|\/gtag\/|\/g\/collect/i, "Google Analytics / GTM"],
  [/connect\.facebook\.net|facebook\.com\/tr/i, "Meta Pixel"],
  [/segment\.(com|io)|cdn\.segment/i, "Segment"],
  [/mixpanel\.com/i, "Mixpanel"],
  [/amplitude\.com/i, "Amplitude"],
  [/hotjar\.com/i, "Hotjar"],
  [/plausible\.io/i, "Plausible"],
  [/posthog\.com/i, "PostHog"],
  [/clarity\.ms/i, "Microsoft Clarity"],
];

export function analyticsProvider(url: string): string | null {
  for (const [re, label] of ANALYTICS_HOSTS) if (re.test(url)) return label;
  return null;
}

/**
 * Canonical URL template: numeric/uuid/hash path segments become placeholders,
 * query string dropped. Lets the crawler treat /product/123 and /product/456
 * as one page type instead of burning the page budget on siblings.
 */
export function urlTemplate(u: string): string {
  try {
    const url = new URL(u);
    const segs = url.pathname.split("/").map((s) => {
      if (/^\d+$/.test(s)) return ":n";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s)) return ":id";
      return s;
    });
    return url.origin + segs.join("/");
  } catch {
    return u;
  }
}

/**
 * Reads robots.txt + sitemap.xml (one nested index level) to learn the site's
 * self-declared page inventory before crawling — the "total idea of the site"
 * upfront, instead of discovering it link by link. Regex parse, no XML dep;
 * .gz sitemaps skipped.
 */
async function seedFromSitemaps(browserCtx: BrowserContext, origin: string): Promise<string[]> {
  const fetchText = async (u: string): Promise<string> => {
    try {
      const r = await browserCtx.request.get(u, { timeout: 10000 });
      return r.ok() ? await r.text() : "";
    } catch {
      return "";
    }
  };
  const locs = (xml: string) => Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);

  const sitemapUrls = new Set<string>([`${origin}/sitemap.xml`]);
  for (const m of (await fetchText(`${origin}/robots.txt`)).matchAll(/^sitemap:\s*(\S+)/gim)) sitemapUrls.add(m[1]);

  const found = new Set<string>();
  let nestedFetched = 0;
  for (const sm of Array.from(sitemapUrls).slice(0, 5)) {
    for (const loc of locs(await fetchText(sm))) {
      if (found.size >= 500) break;
      if (/\.xml$/i.test(loc) && nestedFetched < 3) {
        nestedFetched++;
        for (const inner of locs(await fetchText(loc))) {
          if (found.size >= 500) break;
          if (!/\.xml(\.gz)?$/i.test(inner)) found.add(inner);
        }
      } else if (!/\.xml(\.gz)?$/i.test(loc)) {
        found.add(loc);
      }
    }
  }
  return [...found];
}

/** Parent directory of a path, used to collapse slug-named siblings. */
function parentDir(u: string): string {
  try {
    const url = new URL(u);
    const segs = url.pathname.split("/").filter(Boolean);
    return segs.length >= 2 ? url.origin + "/" + segs.slice(0, -1).join("/") : "";
  } catch {
    return "";
  }
}

// Injected before any navigation so client-side (SPA) route changes are
// captured even when they never trigger a document load — the crawler reads
// window.__spaRoutes after each page settles. Plan-v2 §9 "SPA route discovery".
const SPA_CAPTURE = () => {
  const w = window as unknown as { __spaRoutes?: string[] };
  w.__spaRoutes = [];
  const record = (url: unknown) => {
    if (url == null) return;
    try { w.__spaRoutes!.push(new URL(String(url), location.href).href); } catch { /* ignore */ }
  };
  for (const name of ["pushState", "replaceState"] as const) {
    const orig = history[name];
    history[name] = function (this: History, ...args: unknown[]) {
      record(args[2]);
      return orig.apply(this, args as Parameters<History["pushState"]>);
    } as History[typeof name];
  }
};

/**
 * Collects same-frame and nested links: real <a href> anchors, anchors buried
 * inside shadow DOM (web components), links inside same-origin iframes, and
 * SPA routes captured by SPA_CAPTURE. Cross-origin frames throw on evaluate and
 * are skipped. Plan-v2 §9 "iframe + shadow DOM piercing".
 */
async function collectLinks(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page.frames().map((f) =>
      // Iterative walk on purpose: a named helper const here would get tsx's
      // `__name` decoration and crash in-page (see RunContext.startTrace shim).
      f.evaluate(() => {
        const out: string[] = [];
        const stack: (Document | ShadowRoot)[] = [document];
        while (stack.length) {
          const root = stack.pop()!;
          root.querySelectorAll("a[href]").forEach((a) => out.push((a as HTMLAnchorElement).href));
          root.querySelectorAll("*").forEach((el) => {
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) stack.push(sr);
          });
        }
        const spa = (window as unknown as { __spaRoutes?: string[] }).__spaRoutes;
        if (Array.isArray(spa)) out.push(...spa);
        return out;
      }).catch(() => [] as string[])
    )
  );
  return perFrame.flat();
}

// ponytail: read-only crawl. Skip links that mutate state or end the session.
// Raise MAX_PAGES / relax this when you point it at an app you own and want deeper coverage.
export const UNSAFE = /(logout|log-?out|sign-?out|delete|remove|destroy|deactivate|\/api\/|mailto:|tel:|javascript:)/i;

/**
 * Discovery agent. BFS-crawls same-origin pages starting from the post-login URL,
 * capturing HTTP status, console errors, failed requests, title and a screenshot
 * for each page into ctx.pages. It asserts nothing — verification agents read this.
 */
export async function crawlAgent(
  ctx: RunContext,
  browserCtx: BrowserContext,
  project: Project,
  role: RoleCred,
  startUrl: string
): Promise<void> {
  const origin = new URL(project.baseUrl).origin;
  const queue: string[] = [startUrl];
  const seen = new Set<string>();
  const templateCount = new Map<string, number>();
  const parentCount = new Map<string, number>();
  let collapsed = 0;
  await browserCtx.addInitScript(SPA_CAPTURE);

  // Sitemap seeding: know the whole inventory before the first click.
  const inventory = await seedFromSitemaps(browserCtx, origin).catch(() => [] as string[]);
  if (inventory.length) {
    const safe = inventory.filter((u) => { try { return new URL(u).origin === origin && !UNSAFE.test(u); } catch { return false; } });
    const types = new Set(safe.map(urlTemplate));
    queue.push(...safe);
    ctx.log(AGENT, "step", `Sitemap inventory: ${inventory.length} URL(s) declared, ${types.size} page type(s) — seeded into crawl queue (template sampling picks representatives)`);
  } else {
    ctx.log(AGENT, "step", "No sitemap/robots inventory found — discovery relies on link crawl + interaction clicks");
  }

  while (queue.length && seen.size < MAX_PAGES) {
    const norm = queue.shift()!.split("#")[0];
    if (seen.has(norm)) continue;

    // Template sampling: a few representatives per URL shape, so a 114-surah
    // content site doesn't eat the whole budget with one page type.
    const tpl = urlTemplate(norm);
    const parent = parentDir(norm);
    if ((templateCount.get(tpl) ?? 0) >= MAX_PER_TEMPLATE || (parent && (parentCount.get(parent) ?? 0) >= MAX_PER_PARENT)) {
      collapsed++;
      continue;
    }
    templateCount.set(tpl, (templateCount.get(tpl) ?? 0) + 1);
    if (parent) parentCount.set(parent, (parentCount.get(parent) ?? 0) + 1);
    seen.add(norm);

    const page = await browserCtx.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: CrawledPage["failedRequests"] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
    page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), method: r.method(), status: 0 }));
    page.on("response", (r) => {
      const u = r.url();
      // Skip the main document itself — route-health already reports the page status.
      if (r.status() >= 400 && u.split("#")[0] !== norm) failedRequests.push({ url: u, method: r.request().method(), status: r.status() });
      const ct = r.headers()["content-type"] || "";
      if (u.startsWith(origin) && (ct.includes("application/json") || u.includes("/api/"))) {
        ctx.apiCalls.push({ method: r.request().method(), url: u, status: r.status() });
        // Capture a bounded set of JSON bodies for the api-validation agent (R4).
        if (ct.includes("application/json") && ctx.apiSamples.length < MAX_API_SAMPLES) {
          const method = r.request().method(), status = r.status(), tpl = urlTemplate(u);
          void r.json().then((body: unknown) => ctx.apiSamples.push({ method, url: u, template: tpl, status, body })).catch(() => {});
        }
      }
      const provider = analyticsProvider(u);
      if (provider) ctx.analyticsHits.add(provider);
    });

    let status: number | null = null;
    try {
      let resp = await page.goto(norm, { waitUntil: "domcontentloaded", timeout: 20000 });
      status = resp?.status() ?? null;
      // Session-expiry recovery (§9): if a long crawl's session died and this
      // page bounced to login, re-auth in-context once and re-open — otherwise
      // every remaining page is silently tested logged-out.
      const onLoginPage = norm.toLowerCase().includes(project.loginPath.toLowerCase());
      if (!onLoginPage && (await looksLoggedOut(page, project))) {
        ctx.log(AGENT, "warn", `Session looks expired at ${norm} — re-authenticating ${role.name}`);
        if (await reauth(ctx, browserCtx, project, role)) {
          resp = await page.goto(norm, { waitUntil: "domcontentloaded", timeout: 20000 });
          status = resp?.status() ?? null;
        }
      }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await scrollToBottom(page).catch(() => {});
    } catch (e) {
      ctx.log(AGENT, "warn", `Failed to open ${norm}: ${String(e).slice(0, 160)}`);
    }

    const title = await page.title().catch(() => "");
    ctx.status(AGENT, `Crawling ${norm} as ${role.name}`, { url: norm });
    // route-health checks every crawled page with zero re-navigation (V4 coverage matrix).
    ctx.recordTested(norm, "route-health");
    const shot = seen.size <= 30 ? await ctx.screenshot(page, `${role.name}-${title || "page"}`, { role: role.name }) : null;
    ctx.pages.push({ url: norm, title, role: role.name, status, consoleErrors, failedRequests, screenshot: shot });
    ctx.log(AGENT, "step", `Crawled ${norm} (${status ?? "?"}) — "${title}"`);
    const fromId = recordPageNode(project.id, ctx.runId, norm, title);

    try {
      const hrefs = await collectLinks(page);
      for (const h of hrefs) {
        try {
          const u = new URL(h);
          if (u.origin === origin && !UNSAFE.test(h)) {
            const toId = recordPageNode(project.id, ctx.runId, u.toString(), "");
            recordNavEdge(project.id, fromId, toId);
            if (!seen.has(h.split("#")[0])) queue.push(u.toString());
          }
        } catch (e) { ctx.log(AGENT, "warn", `Link not queued (${h.slice(0, 80)}): ${String(e).slice(0, 120)}`); }
      }
    } catch (e) { ctx.log(AGENT, "warn", `Link collection failed on ${norm}: ${String(e).slice(0, 120)}`); }

    await page.close();
  }

  for (const call of ctx.apiCalls) recordApiNode(project.id, ctx.runId, call.method, call.url, call.status);
  if (collapsed) ctx.log(AGENT, "step", `Collapsed ${collapsed} sibling URL(s) into already-sampled templates (${templateCount.size} distinct page types)`);
  ctx.log(AGENT, "pass", `Discovered ${ctx.pages.filter((p) => p.role === role.name).length} pages for ${role.name}`);
}
