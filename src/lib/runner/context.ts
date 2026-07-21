import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Page, BrowserContext } from "playwright";
import { addEvent, addFinding } from "../db";
import type { Finding, RunEvent, Severity, SiteProfile, RunReport, RootCauseCluster, LighthouseResult } from "../types";
import { rankPages } from "./graph";

export interface CrawledPage {
  url: string;
  title: string;
  role: string;
  status: number | null;
  consoleErrors: string[];
  failedRequests: { url: string; status: number; method: string }[];
  screenshot: string | null;
  changeRank?: number; // 0 new / 1 changed / 2 unchanged — set by reorderByChangeStatus, read by risk sampling (P1)
}

export interface ApiCall {
  method: string;
  url: string;
  status: number;
}

// A captured same-origin JSON response body (Plan-v5 R4). `body` is the parsed
// JSON (object/array/primitive) or null when parsing failed / non-JSON.
export interface ApiSample {
  method: string;
  url: string;
  template: string;
  status: number;
  body: unknown;
}

type FindingInput = Omit<Finding, "id" | "runId" | "kind" | "source" | "confidence" | "fingerprint"> &
  Partial<Pick<Finding, "kind" | "source" | "confidence" | "fingerprint">>;

export class RunContext {
  readonly runId: string;
  readonly projectId: string;
  readonly shotDir: string;
  readonly traceDir: string;
  private shotCount = 0;
  traces: { label: string; path: string }[] = []; // Playwright trace .zip per browser context (V1)
  pages: CrawledPage[] = [];
  apiCalls: ApiCall[] = [];
  apiSamples: ApiSample[] = []; // captured JSON response bodies for the api-validation agent (Plan-v5 R4)
  analyticsHits = new Set<string>(); // analytics/telemetry provider labels seen firing during discovery (Plan-v5 R7)
  siteProfile: SiteProfile | null = null;
  pageTypes = new Map<string, string>(); // url → inferred page type (filled by page-expectations)
  hotPaths = new Set<string>(); // pathnames that carried a finding in recent runs — adaptive sampling bonus (Plan-v5 R3), set by executeRun
  agentsRan = new Set<string>(); // filled by withRecovery — feeds the run report's ran/skipped split
  tested = new Map<string, Set<string>>(); // url → agent names that actually touched it (V4 coverage matrix); testedUrls (P4) is its key set
  // Discovered-vs-tested counters agents increment as they work (P4 coverage accounting).
  coverage = { controlsSeen: 0, controlsClicked: 0, formsSeen: 0, formsAudited: 0, journeysDefined: 0, journeysPassed: 0 };
  patterns: RunReport["patterns"] | null = null; // recurrence/flap, filled by the regression agent (P2)
  rootCauses: RootCauseCluster[] = []; // shared-cause clusters, filled by the root-cause agent (P7), read by the senior reviewer (P6)
  failCount = 0;
  findingCounts = new Map<string, number>(); // agent → findings recorded this run, read by withRecovery for the live timeline (V3)
  lighthouse: LighthouseResult[] = []; // filled by the perf agent's Lighthouse pass (V5)

  constructor(runId: string, projectId: string) {
    this.runId = runId;
    this.projectId = projectId;
    this.shotDir = path.join(process.cwd(), "public", "shots", runId);
    this.traceDir = path.join(process.cwd(), "public", "traces", runId);
    fs.mkdirSync(this.shotDir, { recursive: true });
    fs.mkdirSync(this.traceDir, { recursive: true });
  }

  log(agent: string, level: RunEvent["level"], message: string, data: unknown = null) {
    if (level === "fail") this.failCount++;
    addEvent({
      runId: this.runId,
      ts: new Date().toISOString(),
      agent,
      level,
      message,
      data: data == null ? null : JSON.stringify(data),
    });
  }

  finding(f: FindingInput) {
    const kind = f.kind ?? "bug";
    const source = f.source ?? "deterministic";
    const confidence = f.confidence ?? 1.0;
    const fingerprint = f.fingerprint ?? crypto.createHash("sha1").update(`${f.agent}|${f.title}|${f.pageUrl ?? ""}`).digest("hex").slice(0, 16);
    addFinding({ ...f, kind, source, confidence, fingerprint, runId: this.runId });
    this.findingCounts.set(f.agent, (this.findingCounts.get(f.agent) ?? 0) + 1);
    this.log(f.agent, f.severity === "info" || f.severity === "low" ? "warn" : "fail", `[${f.severity}] ${f.title}`);
  }

  /** Live narration (V3): the four questions every agent should answer — what am I testing, where, doing what, what happened. */
  status(agent: string, message: string, data: unknown = null) {
    this.log(agent, "status", message, data);
  }

  /**
   * Risk-weighted page sample for a role (Plan-v4 P1). Same "reachable page"
   * filter every agent used before, but ordered by risk + recency and with a
   * guaranteed representative of each known page type, so a small sample spends
   * its budget on /checkout and /admin instead of the first six list pages.
   * Records what it hands out into `tested` for coverage accounting (P4, V4).
   */
  sampleFor(roleName: string, n: number, agent: string): CrawledPage[] {
    const pool = this.pages.filter((p) => p.role === roleName && ((p.status ?? 200) < 400 || p.title.trim() !== ""));
    const picked = rankPages(pool, n, this.pageTypes, this.hotPaths);
    for (const p of picked) this.recordTested(p.url, agent);
    return picked;
  }

  /** distinct pages any sampling agent actually visited (P4 coverage) — derived from `tested`. */
  get testedUrls(): Set<string> {
    return new Set(this.tested.keys());
  }

  /** Records a url as touched by an agent — feeds the coverage matrix (V4). Agents that don't sample via `sampleFor` (crawler, interaction's click-adoption, journey, crud, security) call this directly. */
  recordTested(url: string, agent: string): void {
    const set = this.tested.get(url);
    if (set) set.add(agent);
    else this.tested.set(url, new Set([agent]));
  }

  /** Starts a full trace (screenshots + DOM snapshots) for a freshly-created browser context (V1). */
  async startTrace(browserCtx: BrowserContext): Promise<void> {
    // tsx guard: under the tsx CLI (agents/bench/selftest), esbuild's keep-names
    // transform wraps named function consts in a `__name(...)` helper. Playwright
    // serializes evaluate/addInitScript callbacks into the page, where that helper
    // doesn't exist — every such evaluate throws "ReferenceError: __name is not
    // defined" and silent .catch fallbacks turn it into empty results (this is
    // how the crawler found 0 links in tsx runs). Defining a no-op __name in
    // every page fixes all agents at once; harmless under the Next.js bundler.
    await browserCtx.addInitScript("self.__name = self.__name || ((fn) => fn);").catch(() => {});
    await browserCtx.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
    this.attachLiveView(browserCtx);
  }

  /**
   * Live view (V8): CDP screencast on every page of the context, each frame
   * overwriting one well-known file the UI polls at ~4fps — real video-ish
   * live view instead of the sparse screenshot-event slideshow. Chromium only;
   * silently a no-op elsewhere. Last page to render wins the frame file, which
   * is exactly the "follow whatever the run is doing now" behavior we want.
   */
  private attachLiveView(browserCtx: BrowserContext): void {
    const file = path.join(this.shotDir, "live.jpg");
    const tmp = path.join(this.shotDir, "live.jpg.tmp");
    const hook = async (page: Page) => {
      try {
        const cdp = await browserCtx.newCDPSession(page);
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 2 });
        cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
          cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
          try {
            // tmp+rename so the UI never reads a half-written jpeg
            fs.writeFileSync(tmp, Buffer.from(f.data, "base64"));
            fs.renameSync(tmp, file);
          } catch { /* frame dropped — next one lands in ~100ms */ }
        });
      } catch { /* non-chromium browser or page closed mid-attach */ }
    };
    browserCtx.on("page", (p) => void hook(p));
    for (const p of browserCtx.pages()) void hook(p);
  }

  /** Stops the trace started for this context and records it for the run report. Call before `browserCtx.close()`. */
  async stopTrace(browserCtx: BrowserContext, label: string): Promise<void> {
    const file = `${label.replace(/[^a-z0-9-]/gi, "_").slice(0, 60)}.zip`;
    try {
      await browserCtx.tracing.stop({ path: path.join(this.traceDir, file) });
      this.traces.push({ label, path: `/traces/${this.runId}/${file}` });
    } catch {
      // tracing was never started for this context — nothing to stop
    }
  }

  async screenshot(page: Page, label: string, opts?: { fullPage?: boolean; role?: string }): Promise<string | null> {
    try {
      const file = `${String(++this.shotCount).padStart(3, "0")}-${label.replace(/[^a-z0-9-]/gi, "_").slice(0, 60)}.png`;
      await page.screenshot({ path: path.join(this.shotDir, file), fullPage: opts?.fullPage ?? false });
      const rel = `/shots/${this.runId}/${file}`;
      this.log("recorder", "shot", label, { src: rel, role: opts?.role ?? null });
      return rel;
    } catch {
      return null;
    }
  }
}

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/**
 * Scrolls to the bottom in steps until page height stabilizes (or maxIters
 * hits), then resets scroll to top. Triggers lazy-load/IntersectionObserver
 * content before a fullPage screenshot — otherwise a naive fullPage capture
 * (or an AI-driven agent that never scrolls) silently misses anything below
 * the fold that only mounts on scroll. Plan-v2 §9 "guaranteed full-page scroll".
 */
export async function scrollToBottom(page: Page, maxIters = 20): Promise<void> {
  let lastHeight = -1;
  for (let i = 0; i < maxIters; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) break;
    lastHeight = height;
    await page.evaluate((h) => window.scrollTo(0, h), height);
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
