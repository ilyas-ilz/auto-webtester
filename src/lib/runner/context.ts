import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Page, BrowserContext } from "playwright";
import { addEvent, addFinding, askQuestion, getQuestion, expireQuestion, isCancelRequested, touchRun } from "../db";
import { RunCancelledError, setLiveSession, clearLiveSession, liveOwnerKey, registerControlWatcher } from "./control";

// P1-4: process-wide page counter — gives every screencasting page a stable
// identity to own (or not own) the run's live view with.
let liveOwnerSeq = 0;
import { publishFrame } from "./frames";
import type { Finding, RunEvent, Severity, SiteProfile, RunReport, RootCauseCluster, LighthouseResult } from "../types";
import { rankPages } from "./graph";
import { FactStore } from "./facts";
import { normalizeForFingerprint } from "./feedback";

// Far below db.ts's STALE_HEARTBEAT_MS (5 min) so an ordinary slow page never
// looks like a dead process.
const BEAT_INTERVAL_MS = 20_000;

export interface CrawledPage {
  url: string;
  title: string;
  role: string;
  status: number | null;
  consoleErrors: string[];
  failedRequests: { url: string; status: number; method: string }[];
  screenshot: string | null;
  changeRank?: number; // 0 new / 1 changed / 2 unchanged — set by reorderByChangeStatus, read by risk sampling (P1)
  probed?: boolean; // HEAD-probed template-collapsed sibling, never rendered — status is real, title/console/screenshot are not
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

// A state-mutating request captured during a create/delete so a later cross-role
// session can replay it (Plan-v7 §3.2a write-IDOR). Only ever recorded for
// requests carrying our qabot- tag, so a replay can never touch real data.
export interface CapturedWrite {
  method: string;
  url: string;
  postData: string | null;
  contentType: string | null; // original request content-type, replayed verbatim so form/JSON bodies aren't mis-sent
  csrfHeader: string | null; // name of the CSRF/XSRF request header the owner sent, if any (Plan-v7 §8.1) — replay injects the replaying role's OWN token into it so a denial means authz, not a token mismatch
  ownerRole: string; // whose session performed (and owns the target of) this write
  ownerStatus: number; // status the owner's own write returned — the 2xx baseline the oracle needs
  tag: string; // the qabot- value proving the target is a disposable entity we created
}

// `afterHuman` is stamped by the db from the run's takeover state, never by an agent.
// `fingerprintV` is stamped by db.ts (CURRENT_FINGERPRINT_VERSION) at insert time, never by a caller.
type FindingInput = Omit<Finding, "id" | "runId" | "kind" | "source" | "confidence" | "fingerprint" | "afterHuman" | "fingerprintV"> &
  Partial<Pick<Finding, "kind" | "source" | "confidence" | "fingerprint">>;

const RESUME_ALWAYS_RUN = new Set(["login", "crawler"]);

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
  idorWrites: CapturedWrite[] = []; // qabot-tagged mutating writes captured by crud, for the cross-role write-IDOR replay (Plan-v7 §3.2a)
  facts = new FactStore(); // learned app-behavior facts (Plan-v7 §3.4) — gates §3.5 probing; finding ≠ fact
  // Autonomous Resolution Rate accounting (Plan-v7 §6): every unknown effect the learning
  // agent meets, split by how it got resolved. ARR = (byFacts+byProbe)/encountered — the
  // real "brain-like without AI" measure; it should climb while requiredAI falls.
  arr = { encountered: 0, byFacts: 0, byProbe: 0, requiredAI: 0, unresolved: 0 };
  analyticsHits = new Set<string>(); // analytics/telemetry provider labels seen firing during discovery (Plan-v5 R7)
  siteProfile: SiteProfile | null = null;
  pageTypes = new Map<string, string>(); // url → inferred page type (filled by page-expectations)
  hotPaths = new Set<string>(); // pathnames that carried a finding in recent runs — adaptive sampling bonus (Plan-v5 R3), set by executeRun
  agentsRan = new Set<string>(); // filled by withRecovery — feeds the run report's ran/skipped split
  agentsFailed = new Map<string, string>(); // agent → failure reason after retries exhausted (P0-2) — a failed required dimension makes the verdict inconclusive, never a silent PASS
  tested = new Map<string, Set<string>>(); // url → agent names that actually touched it (V4 coverage matrix); testedUrls (P4) is its key set
  // Discovered-vs-tested counters agents increment as they work (P4 coverage accounting).
  coverage = { controlsSeen: 0, controlsClicked: 0, formsSeen: 0, formsAudited: 0, journeysDefined: 0, journeysPassed: 0 };
  patterns: RunReport["patterns"] | null = null; // recurrence/flap, filled by the regression agent (P2)
  rootCauses: RootCauseCluster[] = []; // shared-cause clusters, filled by the root-cause agent (P7), read by the senior reviewer (P6)
  failCount = 0;
  private lastBeatMs = 0;
  private nobodyWatching = false; // set once a human question times out — later asks skip the wait
  findingCounts = new Map<string, number>(); // agent → findings recorded this run, read by withRecovery for the live timeline (V3)
  lighthouse: LighthouseResult[] = []; // filled by the perf agent's Lighthouse pass (V5)
  resumeSteps: string[] = []; // agents the run being resumed already completed, in order — see skipCompleted
  recoveriesUsed: { subject: string; strategy: string; worked: boolean }[] = []; // deterministic recovery attempts this run (Plan-v8 §1) — persisted by experience.ts, recalled next run via recallRecoveryStrategy
  owaspTestedExtra: Partial<Record<string, number>> = {}; // A06/A07 "tested" counts (Plan-v8 §6.4) — one-off checks not in the url×agent `tested` map, set by owasp.ts/login.ts
  private stepIndex = 0;

  constructor(runId: string, projectId: string) {
    this.runId = runId;
    this.projectId = projectId;
    this.shotDir = path.join(process.cwd(), "public", "shots", runId);
    this.traceDir = path.join(process.cwd(), "public", "traces", runId);
    fs.mkdirSync(this.shotDir, { recursive: true });
    fs.mkdirSync(this.traceDir, { recursive: true });
    registerControlWatcher(runId, () => { this.nobodyWatching = false; });
  }

  /**
   * Resume gate for a retried run (called once per agent step, in order).
   * The step sequence is re-derived the same way every run, so a retry can skip
   * what the interrupted run already finished instead of starting over. Skipping
   * stops for good at the first divergence: a different agent at this position
   * means the plan changed, so the rest genuinely has to run. Session + crawl
   * never skip — they live in memory only, and everything after them needs them.
   */
  skipCompleted(agent: string): boolean {
    const i = this.stepIndex++;
    if (i >= this.resumeSteps.length) return false;
    if (this.resumeSteps[i] !== agent) {
      this.resumeSteps = [];
      return false;
    }
    // A-3 (WEBTESTER-AUDIT): positional matching is only sound while each name appears
    // once. Several agents register under a repeated name ("login" three times) and
    // parallel groups complete out of order, so a repeated name at this position could
    // skip the wrong slot. Re-running work is safe; skipping the wrong work is not —
    // so stop skipping entirely at the first ambiguous name.
    if (this.resumeSteps.filter((s) => s === agent).length > 1) {
      this.resumeSteps = [];
      return false;
    }
    return !RESUME_ALWAYS_RUN.has(agent);
  }

  log(agent: string, level: RunEvent["level"], message: string, data: unknown = null) {
    if (level === "fail") this.failCount++;
    // Liveness beat (throttled): every other process decides this run is abandoned
    // from this timestamp, so it must keep ticking for the whole run — agents log
    // constantly, which makes this the cheapest place to prove we're still alive.
    const now = Date.now();
    if (now - this.lastBeatMs > BEAT_INTERVAL_MS) {
      this.lastBeatMs = now;
      touchRun(this.runId);
    }
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
    // Plan-v8 §3.2: normalized inputs (dynamic ids/counts collapsed) so the SAME
    // fingerprint context.ts has always computed is now stable enough for human
    // feedback to stick — a human marking a finding false-positive shouldn't see it
    // return next run just because /users/42 became /users/43.
    const norm = normalizeForFingerprint(f.agent, f.title, f.pageUrl);
    const fingerprint = f.fingerprint ?? crypto.createHash("sha1").update(`${norm.agent}|${norm.title}|${norm.pageUrl}`).digest("hex").slice(0, 16);
    addFinding({ ...f, kind, source, confidence, fingerprint, runId: this.runId });
    this.findingCounts.set(f.agent, (this.findingCounts.get(f.agent) ?? 0) + 1);
    this.log(f.agent, f.severity === "info" || f.severity === "low" ? "warn" : "fail", `[${f.severity}] ${f.title}`);
  }

  /** Live narration (V3): the four questions every agent should answer — what am I testing, where, doing what, what happened. */
  status(agent: string, message: string, data: unknown = null) {
    this.log(agent, "status", message, data);
  }

  /** Throws if the user pressed Stop. Called between agents and inside long waits. */
  checkCancelled(): void {
    if (isCancelRequested(this.runId)) throw new RunCancelledError();
  }

  /**
   * Ask the human watching the live view a question and block until they answer
   * (or the timeout expires, or they stop the run). Returns their answer, or
   * null if nobody was watching — every caller must keep working without one.
   */
  async askHuman(agent: string, question: string, timeoutMs = 120_000): Promise<string | null> {
    // Nobody answered the last one → nobody is watching. Never stall again this
    // run, or a 5-role project with bad credentials would sit idle for 10 minutes.
    if (this.nobodyWatching) return null;
    const id = askQuestion(this.runId, agent, question);
    this.log(agent, "warn", `Waiting for a human answer: ${question}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      this.checkCancelled();
      const q = getQuestion(id);
      if (q?.status === "answered") {
        this.log(agent, "step", `Human answered — continuing`);
        return q.answer ?? "";
      }
    }
    expireQuestion(id);
    this.nobodyWatching = true;
    this.log(agent, "step", "No answer within the wait window — continuing on its own (further questions will be skipped this run)");
    return null;
  }

  /**
   * Risk-weighted page sample for a role (Plan-v4 P1). Same "reachable page"
   * filter every agent used before, but ordered by risk + recency and with a
   * guaranteed representative of each known page type, so a small sample spends
   * its budget on /checkout and /admin instead of the first six list pages.
   * Records what it hands out into `tested` for coverage accounting (P4, V4).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- _agent kept for call-site compatibility; coverage is recorded by observe(), not at pick time (P0-2)
  sampleFor(roleName: string, n: number, _agent?: string): CrawledPage[] {
    const pool = this.pages.filter((p) => p.role === roleName && ((p.status ?? 200) < 400 || p.title.trim() !== ""));
    // P0-2 (WEBTESTER-AUDIT): selection is NOT coverage. Agents record via observe()
    // (or recordTested after their own successful navigation) — never at pick time.
    return rankPages(pool, n, this.pageTypes, this.hotPaths);
  }

  /**
   * Navigate + record coverage only on success (P0-2). Throws on navigation failure —
   * callers' existing try/catch "warn and continue" paths handle it, and a failed
   * page is then honestly absent from the coverage matrix.
   */
  async observe(page: Page, url: string, agent: string, opts?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number }): Promise<void> {
    await page.goto(url, { waitUntil: opts?.waitUntil ?? "domcontentloaded", timeout: opts?.timeout ?? 20000 });
    this.recordTested(url, agent);
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
        // P1-4: a stable identity for this page, so live-view ownership is explicit
        // instead of "whichever page painted last".
        const ownerKey = `${++liveOwnerSeq}`;
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 2 });
        page.once("close", () => clearLiveSession(this.runId, cdp));
        cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
          cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
          // Only the owning page streams and receives human input; a non-owner's
          // frames are acked (so its screencast doesn't stall) and dropped.
          setLiveSession(this.runId, ownerKey, cdp, f.metadata?.deviceWidth ?? 1280, f.metadata?.deviceHeight ?? 900);
          if (liveOwnerKey(this.runId) !== ownerKey) return;
          publishFrame(this.runId, f.data); // push to any SSE watcher; the file below stays as the poll fallback
          // P1-5 (WEBTESTER-AUDIT): async one-in-flight write — sync writes on every
          // CDP frame stalled the event loop under Playwright load. A newer frame
          // simply replaces the queued one; dropping frames is free.
          this.pendingFrame = Buffer.from(f.data, "base64");
          if (!this.frameWriteBusy) void this.flushFrames(tmp, file);
        });
      } catch { /* non-chromium browser or page closed mid-attach */ }
    };
    browserCtx.on("page", (p) => void hook(p));
    for (const p of browserCtx.pages()) void hook(p);
  }

  private frameWriteBusy = false;
  private pendingFrame: Buffer | null = null;
  /** Drains the single-slot frame queue: writes the newest pending frame, skipping any it superseded (P1-5). */
  private async flushFrames(tmp: string, file: string): Promise<void> {
    this.frameWriteBusy = true;
    try {
      while (this.pendingFrame) {
        const buf = this.pendingFrame;
        this.pendingFrame = null;
        // tmp+rename so the UI never reads a half-written jpeg
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, file);
      }
    } catch { /* frame dropped — next one lands in ~100ms */ }
    this.frameWriteBusy = false;
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
    } catch (e) {
      // P1-8 (WEBTESTER-AUDIT): a missing screenshot is a fact the report needs,
      // not a silent null — the finding will say WHY its evidence is absent.
      this.log("recorder", "warn", `Screenshot "${label}" failed: ${String(e).slice(0, 120)} — evidence unavailable for this step`);
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
