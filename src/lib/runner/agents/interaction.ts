import type { BrowserContext, Page } from "playwright";
import type { RoleCred } from "../../types";
import { RunContext, scrollToBottom, type CrawledPage } from "../context";
import { RunCancelledError } from "../control";
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
/**
 * True when a console line is a real JavaScript error (thrown exception), false when
 * it's the browser reporting a failed network request. Only the former justifies
 * "clicking this control is broken" — the latter is reported by route-health per page.
 */
/**
 * Did this click really do nothing? Corroboration before an accusation.
 *
 * "The control is dead" is an *inference*, not an observation — unlike an axe rule
 * failure or a missing cookie flag, which are facts the moment they're seen. So it
 * has to survive every cheap counter-signal we can collect: a re-render (node
 * delta), a content swap that keeps the node count identical (language toggle, tab,
 * sort, filter), a request the click fired, or a navigation. Any one of those means
 * the control worked and we say nothing. Only a click that moved *nothing* is
 * reported, and even then at low confidence.
 *
 * Pure — selftested. False positives here are expensive: they teach a reader to
 * distrust the whole report.
 */
export function clickDidNothing(s: { nodeDelta: number; textChanged: boolean; requestsFired: number; urlChanged: boolean }): boolean {
  return s.nodeDelta < 2 && !s.textChanged && s.requestsFired === 0 && !s.urlChanged;
}

export function isJsError(line: string): boolean {
  if (/^failed to load resource\b/i.test(line.trim())) return false;
  if (/^(net::|access to (fetch|xmlhttprequest))/i.test(line.trim())) return false;
  if (/\b(refused to (connect|load|execute)|blocked by cors|content security policy)\b/i.test(line)) return false;
  return true;
}

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

// Search/filter inputs the click-explorer can't exercise — typing is the only
// way to prove a search box actually searches.
const SEARCHABLE = 'input[type="search"], [role="searchbox"], input[placeholder*="search" i], input[placeholder*="filter" i], input[aria-label*="search" i], input[name*="search" i], input[name*="query" i], input[name="q"]';

// A term no real dataset contains — the negative control. A search that returns
// the same rows for this as for a real term is not filtering on the query.
const MISS_QUERY = "zqx9vwk";
const HIT_QUERY = "a"; // single letter: matches something on almost any dataset

/** One measurement of the result region, taken before typing and after each query. */
export interface SearchProbeSample {
  url: string;
  itemCount: number; // size of the largest repeated sibling group = the result list
  textLen: number; // text length of that region
  sawQueryRequest: boolean; // a same-origin request carrying the typed term
}

export type SearchVerdict = "dead" | "ignores-query" | "works" | "inconclusive";

/**
 * Deterministic verdict from three samples: the page before typing, after a
 * term that should match, and after a nonsense term that should not.
 *
 * Reacting is not searching. A box that fires a request but returns the same
 * rows for "a" and for "zqx9vwk" is wired to nothing that filters — that is
 * the bug users actually report, and the old any-reaction check passed it.
 */
export function searchVerdict(base: SearchProbeSample, hit: SearchProbeSample, miss: SearchProbeSample): SearchVerdict {
  const changed = (a: SearchProbeSample, b: SearchProbeSample): boolean =>
    a.url !== b.url || a.itemCount !== b.itemCount || Math.abs(a.textLen - b.textLen) >= 20 || b.sawQueryRequest;
  if (!changed(base, hit) && !changed(base, miss)) return "dead";
  // Nothing countable on the page (no list, no text) — can't tell filtering from
  // a no-op, so say nothing rather than guess.
  if (base.itemCount === 0 && hit.itemCount === 0 && miss.itemCount === 0 && Math.abs(hit.textLen - base.textLen) < 20) return "inconclusive";
  const sameResults = hit.itemCount === miss.itemCount && Math.abs(hit.textLen - miss.textLen) < 20;
  return sameResults ? "ignores-query" : "works";
}

/** Measures the result region: largest repeated sibling group, else <main>. */
async function measureResults(page: Page, sawQueryRequest: boolean): Promise<SearchProbeSample> {
  const m = await page.evaluate(() => {
    let best = 0;
    let bestEl: Element | null = null;
    for (const parent of Array.from(document.querySelectorAll("ul, ol, tbody, [class]")).slice(0, 400)) {
      const byKey = new Map<string, number>();
      for (const child of Array.from(parent.children)) {
        const key = child.tagName + "." + child.className;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
      }
      for (const n of byKey.values()) if (n > best) { best = n; bestEl = parent; }
    }
    const region = bestEl ?? document.querySelector("main, [role='main']") ?? document.body;
    return { itemCount: best, textLen: ((region as Element).textContent ?? "").replace(/\s+/g, " ").trim().length };
  }).catch(() => ({ itemCount: 0, textLen: 0 }));
  return { url: page.url(), ...m, sawQueryRequest };
}

/**
 * Types a query into up to `max` search/filter boxes and checks the box really
 * searches: a matching term and a nonsense term must not produce the same
 * results. Typing is keystroke-by-keystroke — `fill()` skips keydown/keyup, so
 * type-ahead filters bound to key events looked dead under the old probe.
 */
async function probeSearchBoxes(ctx: RunContext, page: Page, role: RoleCred, pageUrl: string, max = 2): Promise<number> {
  const count = await page.locator(SEARCHABLE).count().catch(() => 0);
  let probed = 0;
  for (let i = 0; i < count && probed < max; i++) {
    const box = page.locator(SEARCHABLE).nth(i);
    if (!(await box.isVisible().catch(() => false)) || !(await box.isEditable().catch(() => false))) continue;
    probed++;
    const label = ((await box.getAttribute("placeholder").catch(() => "")) || (await box.getAttribute("aria-label").catch(() => "")) || (await box.getAttribute("name").catch(() => "")) || "search").slice(0, 50);
    ctx.status(AGENT, `Searching "${HIT_QUERY}" / "${MISS_QUERY}" in box "${label}" as ${role.name}`, { url: pageUrl });

    const homeUrl = page.url();
    const base = await measureResults(page, false);

    // Runs one query and returns what the page looked like afterwards, then
    // returns to the starting URL so the next query starts from the same state.
    const runQuery = async (q: string): Promise<SearchProbeSample | null> => {
      let sawQueryRequest = false;
      const onReq = (req: { url(): string }): void => {
        try {
          const u = new URL(req.url());
          if (u.origin === new URL(homeUrl).origin && decodeURIComponent(u.search + u.pathname).toLowerCase().includes(q.toLowerCase())) sawQueryRequest = true;
        } catch { /* data:/blob: */ }
      };
      page.on("request", onReq);
      try {
        const field = page.locator(SEARCHABLE).nth(i);
        await field.click({ timeout: 3000 });
        await field.fill("", { timeout: 3000 });
        await field.pressSequentially(q, { delay: 40, timeout: 5000 }); // real key events
        await page.waitForTimeout(900); // debounce window for type-ahead filters
        await field.press("Enter").catch(() => {});
        await page.waitForTimeout(1200);
      } catch {
        page.off("request", onReq);
        return null; // box disappeared / covered — not a finding
      }
      page.off("request", onReq);
      const sample = await measureResults(page, sawQueryRequest);
      if (page.url() !== homeUrl) {
        await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(SETTLE_MS);
      }
      return sample;
    };

    const hit = await runQuery(HIT_QUERY);
    const miss = hit ? await runQuery(MISS_QUERY) : null;
    if (!hit || !miss) continue;

    const verdict = searchVerdict(base, hit, miss);
    if (verdict === "dead") {
      ctx.finding({
        agent: AGENT, severity: "medium", confidence: 0.7, role: role.name, pageUrl,
        title: `Search/filter box "${label}" does not search`,
        detail: `Typed "${HIT_QUERY}" and "${MISS_QUERY}" (keystroke by keystroke, then Enter): no navigation, no result change, and no request carrying the term. The box renders but appears to be wired to nothing.`,
        evidence: await ctx.screenshot(page, `${role.name}-dead-search-${label}`),
      });
    } else if (verdict === "ignores-query") {
      ctx.finding({
        agent: AGENT, severity: "medium", confidence: 0.6, role: role.name, pageUrl,
        title: `Search/filter box "${label}" ignores the query`,
        detail: `The box reacts, but a real term ("${HIT_QUERY}") and a nonsense term ("${MISS_QUERY}") return the same results (${hit.itemCount} item(s) both times, same result text). Searching runs but does not filter on what was typed.`,
        evidence: await ctx.screenshot(page, `${role.name}-search-ignores-query-${label}`),
      });
    } else if (verdict === "works") {
      ctx.log(AGENT, "pass", `Search box "${label}" filters on the query (${base.itemCount}→${hit.itemCount} item(s) for "${HIT_QUERY}", ${miss.itemCount} for "${MISS_QUERY}") on ${pageUrl}`);
    } else {
      ctx.log(AGENT, "step", `Search box "${label}" reacts but has no countable results to compare — no verdict on ${pageUrl}`);
    }
    await page.locator(SEARCHABLE).nth(i).fill("").catch(() => {});
  }
  return probed;
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

  let clicks = 0, deadControls = 0, routesFound = 0, mediaChecked = 0, explored = 0, adopted = 0, searchesProbed = 0;
  const known = new Set(ctx.pages.filter((p) => p.role === role.name).map((p) => p.url));
  const perTemplate = new Map<string, number>();
  const queue = [...pages];

  while (queue.length) {
    ctx.checkCancelled(); // P1-3: pages × controls × waits is the longest loop in the fleet — stop between pages
    const crawled = queue.shift()!;
    explored++;
    const page = await browserCtx.newPage();
    // "Failed to load resource: … 401" is a *network* failure the browser logs to the
    // console — attributing it to the click that happened to be in flight produced
    // findings like `Clicking "ഹോം" throws a JS error → 401 analytics beacon`, which is
    // wrong twice: it isn't a JS error, and the click didn't cause it.
    const consoleErrors: string[] = [];
    let requestCount = 0;
    page.on("request", () => { requestCount++; });
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));

    try {
      await ctx.observe(page, crawled.url, AGENT);
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

      // --- search/filter probe ---
      searchesProbed += await probeSearchBoxes(ctx, page, role, crawled.url).catch(() => 0);

      // --- click exploration ---
      const startUrl = page.url();
      const locators = await page.locator(CLICKABLE).all();
      ctx.coverage.controlsSeen += locators.length; // P4 coverage: interactive controls discovered
      let tried = 0;
      for (const el of locators) {
        ctx.checkCancelled(); // P1-3: also stop between control clicks on a control-heavy page
        if (tried >= MAX_ELEMENTS_PER_PAGE) break;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        const label = ((await el.textContent().catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "").trim().slice(0, 60);
        if (UNSAFE.test(label)) continue;
        tried++;

        const errBefore = consoleErrors.length;
        const nodesBefore = await page.evaluate(() => document.querySelectorAll("*").length).catch(() => 0);
        // Corroborating signals for the "did nothing" verdict below. Node count alone
        // is blind to a control that swaps text (language toggle, tab, sort) or fires
        // a request without re-rendering — both are the control working.
        const textBefore = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
        const reqBefore = requestCount;
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
        const newErrors = consoleErrors.slice(errBefore);
        const jsErrors = newErrors.filter(isJsError); // background 401/CORS beacons are route-health's job, not "this click is broken"
        if (jsErrors.length) {
          ctx.finding({
            agent: AGENT, severity: "medium", role: role.name, pageUrl: crawled.url,
            title: `Clicking "${label || "(unlabeled control)"}" throws a JS error`,
            detail: jsErrors.join("\n"),
            evidence: await ctx.screenshot(page, `click-error-${label || "control"}`),
          });
        } else if (newErrors.length && Math.abs(nodesAfter - nodesBefore) >= 2) {
          // Something happened AND a request failed — worth saying, but as a failed
          // request, not as a JS exception the click threw.
          ctx.log(AGENT, "step", `Click "${label || "(unlabeled)"}" produced a failed request: ${newErrors[0]}`);
        } else if (clickDidNothing({
          nodeDelta: Math.abs(nodesAfter - nodesBefore),
          textChanged: (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => textBefore)) !== textBefore,
          requestsFired: requestCount - reqBefore,
          urlChanged: false, // a changed URL was already handled and `continue`d above
        })) {
          // ponytail: still blind to pure style/canvas changes — upgrade to a
          // MutationObserver if this proves noisy.
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
      if (e instanceof RunCancelledError) throw e; // P1-3: a stop is not an exploration flake — finally still closes the page
      ctx.log(AGENT, "warn", `Exploration failed on ${crawled.url}: ${String(e).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  ctx.coverage.controlsClicked += clicks; // P4 coverage: controls actually exercised
  ctx.log(AGENT, "pass", `Explored ${explored} page(s) for ${role.name}: ${clicks} clicks, ${routesFound} click-only route(s) discovered (${adopted} adopted into page set), ${deadControls} suspect dead control(s), ${mediaChecked} media element(s) probed, ${searchesProbed} search box(es) exercised`);
}
