import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";
import { nanoid } from "nanoid";
import type { Project, RoleCred, RunMode, RunReport, RunReportSession, CoverageTotals, CoverageMatrix, CoverageMatrixRow } from "../types";
import { createRun, updateRun, getRun, listFindings, recentFindingUrls, lastFinishedCommitSha, listGraphNodes } from "../db";
import { codeRootCause, currentCommitSha, changedFilesSince, mapChangedFilesToPaths } from "./repo";
import { RunContext } from "./context";
import { planMission } from "./planner";
import { profilesForMode, type BrowserEngine } from "./devices";
import { snapshotPageLabels, reorderByChangeStatus } from "./graph";
import { loginAgent, looksLoggedOut, detectAuthType } from "./agents/login";
import { crawlAgent, urlTemplate } from "./agents/crawler";
import { classifierAgent } from "./agents/classifier";
import { interactionAgent } from "./agents/interaction";
import { expectationsAgent } from "./agents/expectations";
import { pageJudgeAgent } from "./agents/pageJudge";
import { routeHealthAgent } from "./agents/routeHealth";
import { apiMapperAgent } from "./agents/apiMapper";
import { formValidationAgent } from "./agents/formValidation";
import { dataIntegrityAgent } from "./agents/dataIntegrity";
import { securityAgent, zapBaselineScan } from "./agents/security";
import { a11yAgent } from "./agents/a11y";
import { perfAgent, lighthouseAudit } from "./agents/perf";
import { uiAuditAgent } from "./agents/uiAudit";
import { visualAgent } from "./agents/visual";
import { permissionsAgent, type RoleSession } from "./agents/permissions";
import { aiReviewerAgent } from "./agents/aiReviewer";
import { regressionAgent } from "./agents/regression";
import { registerAgent } from "./agents/register";
import { crudAgent } from "./agents/crud";
import { rootCauseAgent } from "./agents/rootCause";
import { seoAgent } from "./agents/seo";
import { requirementsAgent } from "./agents/requirements";
import { apiValidationAgent } from "./agents/apiValidation";
import { analyticsAgent } from "./agents/analytics";
import { memoryLeakAgent } from "./agents/memory";
import { fileUploadAgent } from "./agents/fileUpload";
import { emailFlowsAgent } from "./agents/emailFlows";
import { explorerAgent } from "./agents/explorer";
import { journeyAgent } from "./agents/journey";
import { seniorReviewerAgent } from "./agents/seniorReviewer";
import { resilienceAgent } from "./agents/resilience";
import { chaosAgent } from "./agents/chaos";
import { withRecovery } from "./recovery";

const LAUNCHERS = { chromium, firefox, webkit } as const;

// ponytail: hard cap on roles kept logged-in simultaneously for the primary
// profile — the permissions agent needs every role's session open at once
// (§ cross-role check), and each Chromium context is ~100-300MB, so unbounded
// roles could OOM the host. Raise when moving to a real job queue with
// per-host memory accounting.
const MAX_SIMULTANEOUS_ROLE_SESSIONS = 6;

async function launchEngines(engines: Set<BrowserEngine>): Promise<Map<BrowserEngine, Browser>> {
  const map = new Map<BrowserEngine, Browser>();
  // Dev-only visibility: HEADED=1 shows the real browser window instead of running headless.
  const launchOpts = process.env.HEADED === "1" ? { headless: false, slowMo: 100 } : {};
  for (const engine of engines) map.set(engine, await LAUNCHERS[engine].launch(launchOpts));
  return map;
}

// Pseudo-roles for non-password auth: an injected storage-state session (the
// only way to test OAuth-only sites — automating the Google consent screen is
// a dead end) and anonymous public-surface testing when no auth is configured.
const SESSION_ROLE: RoleCred = { id: "__session", name: "Session", username: "", password: "" };
const ANON_ROLE: RoleCred = { id: "__anon", name: "Anonymous", username: "", password: "" };

interface SessionSpec { role: RoleCred; auth: "password" | "storage" | "none" }

function sessionSpecs(project: Project): SessionSpec[] {
  const specs: SessionSpec[] = project.roles
    .slice(0, MAX_SIMULTANEOUS_ROLE_SESSIONS)
    .map((role) => ({ role, auth: "password" as const }));
  if (project.sessionState) specs.push({ role: SESSION_ROLE, auth: "storage" });
  if (!specs.length) specs.push({ role: ANON_ROLE, auth: "none" });
  return specs;
}

/**
 * Establishes one browser session per spec: password login via the login
 * agent, cookie/storage-state injection for OAuth-only sites (verified by
 * loading the app and checking we weren't bounced to login), or a plain
 * unauthenticated context.
 */
async function openSession(
  ctx: RunContext,
  browser: Browser,
  contextOptions: Record<string, unknown>,
  project: Project,
  spec: SessionSpec
): Promise<{ browserCtx: BrowserContext; startUrl: string } | null> {
  const opts = { ...contextOptions, ignoreHTTPSErrors: project.envTag === "localhost" };

  if (spec.auth === "none") {
    const browserCtx = await browser.newContext(opts);
    await ctx.startTrace(browserCtx);
    return { browserCtx, startUrl: project.baseUrl };
  }
  ctx.agentsRan.add("login"); // primary-profile logins are called directly, not via withRecovery
  const loginStartedAt = Date.now();
  const loginFindingsBefore = ctx.findingCounts.get("login") ?? 0;
  ctx.log("login", "agent-start", "login started");
  const endLogin = (failed: boolean): void => {
    ctx.log("login", "agent-done", `login ${failed ? "failed" : "finished"}`, {
      durationMs: Date.now() - loginStartedAt,
      findings: (ctx.findingCounts.get("login") ?? 0) - loginFindingsBefore,
      failed,
    });
  };

  if (spec.auth === "storage") {
    const browserCtx = await browser.newContext({ ...opts, storageState: JSON.parse(project.sessionState) });
    await ctx.startTrace(browserCtx);
    const page = await browserCtx.newPage();
    try {
      await page.goto(project.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    } catch (e) {
      ctx.finding({
        agent: "login", severity: "critical", role: spec.role.name, pageUrl: project.baseUrl,
        title: "App failed to load with injected session state", detail: String(e), evidence: null,
      });
      endLogin(true);
      await ctx.stopTrace(browserCtx, spec.role.name);
      await browserCtx.close();
      return null;
    }
    if (await looksLoggedOut(page, project)) {
      const shot = await ctx.screenshot(page, "session-state-rejected");
      ctx.finding({
        agent: "login", severity: "high", role: spec.role.name, pageUrl: page.url(),
        title: "Injected session state is not logged in",
        detail: "The app bounced to the login page with the stored cookies. The session state has likely expired — log in manually again and re-export it (npx playwright codegen --save-storage=state.json <url>).",
        evidence: shot,
      });
      endLogin(true);
      await ctx.stopTrace(browserCtx, spec.role.name);
      await browserCtx.close();
      return null;
    }
    const startUrl = page.url();
    await page.close();
    endLogin(false);
    ctx.log("login", "pass", `[${spec.role.name}] Injected session state accepted, landed on ${startUrl}`);
    return { browserCtx, startUrl };
  }

  const browserCtx = await browser.newContext(opts);
  await ctx.startTrace(browserCtx);
  const page = await loginAgent(ctx, browserCtx, project, spec.role);
  endLogin(!page);
  if (!page) {
    await ctx.stopTrace(browserCtx, spec.role.name);
    await browserCtx.close();
    return null;
  }
  const startUrl = page.url();
  await page.close();
  return { browserCtx, startUrl };
}

/**
 * Orchestrator (Plan-v2 plane 1): executes the Mission Planner's plan.
 * Primary device profile: logs in every role first and keeps each role's
 * browser context open for the whole pass — needed so the permissions agent
 * can reuse an already-authenticated session to probe another role's routes
 * without re-logging in. Additional profiles (mobile/other engines, mode-
 * dependent) get their own short-lived login + re-render pass afterward.
 */
async function executeRun(runId: string, project: Project, mode: RunMode): Promise<void> {
  const ctx = new RunContext(runId, project.id);
  const mission = planMission(project, mode);
  const specs = sessionSpecs(project);
  ctx.log("orchestrator", "step", `Run ${runId} started for ${project.name} (${project.baseUrl}) — ${mission.reason}`);

  // Execution dimension (Plan-v2 §4): profiles[0] is the primary (Desktop
  // Chrome) — it gets the full pipeline. Any additional profiles (mobile
  // viewport, other engines) only re-render already-discovered pages; see
  // devices.ts for why that's cheap instead of a second full crawl.
  const profiles = profilesForMode(mode);
  const browserByEngine = await launchEngines(new Set(profiles.map((p) => p.browserType)));
  const sessions: (RoleSession & { startUrl: string })[] = [];
  let aiTokens = 0;

  // Change detection (§3.3): snapshot prior page labels BEFORE this run's
  // crawl overwrites them in the graph — otherwise there'd be nothing left
  // to diff against.
  const priorPageLabels = snapshotPageLabels(project.id);

  // Adaptive sampling (Plan-v5 R3): pages that carried findings in recent runs
  // get a sampling bonus, so historically-broken areas keep getting attention.
  for (const u of recentFindingUrls(project.id)) {
    try { ctx.hotPaths.add(new URL(u).pathname); } catch { /* skip non-URL evidence paths */ }
  }

  // Git-diff regression focus (Plan-v6 V8): when the project points at its own
  // repo, files changed since the last run's commit map to known routes (the
  // graph's page inventory from prior runs) and join hotPaths — the existing
  // +30 sampling bonus does the rest. First run / no git / no prior sha → no-op.
  let regressionFocus: RunReport["regressionFocus"];
  if (project.repoPath.trim()) {
    const sha = await currentCommitSha(project.repoPath.trim());
    if (sha) {
      updateRun(runId, { commitSha: sha });
      const prevSha = lastFinishedCommitSha(project.id, runId);
      if (prevSha && prevSha !== sha) {
        const changed = (await changedFilesSince(project.repoPath.trim(), prevSha)) ?? [];
        const known = listGraphNodes(project.id, "page").map((n) => n.key);
        const mapped = mapChangedFilesToPaths(changed, known);
        for (const p of mapped.keys()) ctx.hotPaths.add(p);
        if (mapped.size) {
          regressionFocus = { commitSha: sha, previousSha: prevSha, changedFiles: changed.length, paths: [...mapped.keys()] };
          ctx.log("orchestrator", "step", `${changed.length} file(s) changed since the last run (${prevSha.slice(0, 7)}…${sha.slice(0, 7)}) — prioritizing ${mapped.size} matching route(s) in this run's samples`);
        }
      }
    }
  }

  try {
    const primary = profiles[0];
    const primaryBrowser = browserByEngine.get(primary.browserType)!;

    // Self-registration (V1): once per run, unauthenticated, only if a signup
    // path is configured. Proves the new-user flow before we test as existing roles.
    if (project.registerPath) {
      const regCtx = await primaryBrowser.newContext({ ...primary.contextOptions, ignoreHTTPSErrors: project.envTag === "localhost" });
      await ctx.startTrace(regCtx);
      await withRecovery(ctx, "register", () => registerAgent(ctx, regCtx, project));
      await ctx.stopTrace(regCtx, "register");
      await regCtx.close();
    }

    // Forgot-password email flow (Plan-v5 R9): once, unauthenticated, only when a
    // test inbox + a role email exist. Non-destructive (requests a reset, doesn't complete it).
    if (project.testInboxUrl && project.roles.length) {
      const efCtx = await primaryBrowser.newContext({ ...primary.contextOptions, ignoreHTTPSErrors: project.envTag === "localhost" });
      await ctx.startTrace(efCtx);
      await withRecovery(ctx, "email-flows", () => emailFlowsAgent(ctx, efCtx, project));
      await ctx.stopTrace(efCtx, "email-flows");
      await efCtx.close();
    }

    if (project.roles.length > MAX_SIMULTANEOUS_ROLE_SESSIONS) {
      ctx.log("orchestrator", "warn", `${project.roles.length} roles configured, only running the first ${MAX_SIMULTANEOUS_ROLE_SESSIONS} simultaneously (memory cap) — increase MAX_SIMULTANEOUS_ROLE_SESSIONS or split into multiple projects.`);
    }
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      // Stagger multi-role logins: firing several credential POSTs back-to-back
      // while prior sessions poll /api/auth/session triggers burst contention /
      // auth rate-limiting, which made the last role(s) intermittently fail. A
      // short gap between logins (not before the first) makes it reliable.
      if (i > 0) await new Promise((r) => setTimeout(r, 2500));
      const opened = await openSession(ctx, primaryBrowser, primary.contextOptions, project, spec);
      if (!opened) {
        ctx.log("orchestrator", "warn", `Skipping ${spec.role.name}: could not establish session`);
        continue;
      }
      sessions.push({ role: spec.role, ...opened });
    }

    // All configured logins failed (Plan-v3 Fix B): fall back to an anonymous
    // public-surface pass instead of testing nothing. The login criticals stay
    // in the report; this keeps the rest of it from being empty.
    if (!sessions.length && specs.some((s) => s.auth !== "none")) {
      const browserCtx = await primaryBrowser.newContext({ ...primary.contextOptions, ignoreHTTPSErrors: project.envTag === "localhost" });
      await ctx.startTrace(browserCtx);
      sessions.push({ role: ANON_ROLE, browserCtx, startUrl: project.baseUrl });
      ctx.finding({
        agent: "orchestrator", severity: "info", role: ANON_ROLE.name, pageUrl: project.baseUrl,
        title: "All configured logins failed — fell back to anonymous public-surface testing",
        detail: `None of the ${specs.length} configured session(s) could be established — the login findings quote what the site said for each role. Public pages were still crawled and tested so this run is not empty. Verify the credentials by hand on this exact environment, then re-run.`,
        evidence: null,
      });
    }

    // Anonymous-only run (nothing configured, or everything failed and we fell
    // back): classify the login page (password vs OAuth-only vs magic-link) so
    // the report explains why auth flows were skipped and what would enable them.
    if (sessions[0]?.role.id === ANON_ROLE.id) {
      await withRecovery(ctx, "login", () => detectAuthType(ctx, sessions[0].browserCtx, project));
    }

    // Each agent is wrapped in the recovery middleware (§3.5) so one agent
    // throwing retries once and then continues — it never skips the rest of
    // the role's agents the way a single per-role try/catch would.
    for (const session of sessions) {
      const { startUrl, role } = session;
      const firstRole = session === sessions[0];
      ctx.log("orchestrator", "step", `=== ${primary.name} · Role: ${role.name} ===`);
      await withRecovery(ctx, "crawler", () => crawlAgent(ctx, session.browserCtx, project, role, startUrl));
      const { newCount, changedCount } = reorderByChangeStatus(ctx.pages, priorPageLabels);
      if (newCount || changedCount) ctx.log("orchestrator", "step", `${newCount} new page(s), ${changedCount} changed since last run — prioritized in this run's samples`);
      // Once per run, needs crawl data — tells the report (and AI reviewer) what kind of site this is.
      if (firstRole) await withRecovery(ctx, "site-classifier", () => classifierAgent(ctx, session.browserCtx, project));
      // Interaction runs early on purpose: routes it discovers by clicking
      // (button-nav SPAs) are adopted into ctx.pages, so every agent below
      // — expectations, a11y, perf, ui, visual — tests them too.
      await withRecovery(ctx, "interaction", () => interactionAgent(ctx, session.browserCtx, role, mission.sampleSize));
      await withRecovery(ctx, "route-health", async () => routeHealthAgent(ctx, role));
      await withRecovery(ctx, "page-expectations", () => expectationsAgent(ctx, session.browserCtx, role, mission.sampleSize));
      await withRecovery(ctx, "api-mapper", async () => apiMapperAgent(ctx, project.id));

      // P3: the spine above is order-dependent (interaction adopts routes,
      // expectations fills pageTypes — both feed everyone). These verifiers only
      // READ the discovered pages, so they parallelize. Two cost tiers: cheap DOM
      // readers first, then CPU-heavier renderers. `perf` runs alone (concurrent
      // load skews navigation timing); `visual` runs last (it writes baselines).
      // withRecovery isolates each; the shared context handles concurrent pages,
      // and the screenshot counter increments synchronously before any await.
      await Promise.all([
        withRecovery(ctx, "security", () => securityAgent(ctx, session.browserCtx, project, firstRole)),
        withRecovery(ctx, "form-validation", () => formValidationAgent(ctx, session.browserCtx, role, mission.sampleSize, project.envTag)),
        withRecovery(ctx, "data-integrity", () => dataIntegrityAgent(ctx, session.browserCtx, role, mission.sampleSize)),
      ]);
      await Promise.all([
        withRecovery(ctx, "a11y", () => a11yAgent(ctx, session.browserCtx, role, mission.sampleSize)),
        withRecovery(ctx, "ui-audit", () => uiAuditAgent(ctx, session.browserCtx, role, mission.sampleSize)),
        withRecovery(ctx, "seo", () => seoAgent(ctx, session.browserCtx, project, role, mission.sampleSize, firstRole)),
      ]);
      await withRecovery(ctx, "perf", () => perfAgent(ctx, session.browserCtx, role, mission.sampleSize));
      await withRecovery(ctx, "visual", () => visualAgent(ctx, session.browserCtx, project.id, role, mission.sampleSize));

      // File-upload probe (Plan-v5 R5): only when a sample file is configured;
      // non-production only (it submits a real file — guarded inside the agent too).
      if (project.uploadFilePath) await withRecovery(ctx, "file-upload", () => fileUploadAgent(ctx, session.browserCtx, project, role, mission.sampleSize));

      // Full-mode adversarial passes (P8 fault injection, P10 browser chaos, R18
      // memory leak) — heavier, so gated to full runs. Read-only; after the baseline.
      if (mode === "full") {
        await withRecovery(ctx, "resilience", () => resilienceAgent(ctx, session.browserCtx, project, role, mission.sampleSize));
        await withRecovery(ctx, "chaos", () => chaosAgent(ctx, session.browserCtx, role, mission.sampleSize));
        await withRecovery(ctx, "memory-leak", () => memoryLeakAgent(ctx, session.browserCtx, role, primary.name));
      }
      // CRUD writes (V5): full mode only, non-prod only (guarded inside the agent too).
      if (mode === "full") await withRecovery(ctx, "crud", () => crudAgent(ctx, session.browserCtx, project, role));
    }

    await withRecovery(ctx, "permissions", () => permissionsAgent(ctx, sessions));

    // Additional device profiles: fresh login (catches device-specific auth
    // bugs) then re-render the primary crawl's known pages under this
    // engine/viewport — no re-crawl, no re-run of crawl-derived agents
    // (security/forms/api-mapper would just repeat identical server data).
    for (const profile of profiles.slice(1)) {
      const profileBrowser = browserByEngine.get(profile.browserType)!;
      for (const spec of specs) {
        const role = spec.role;
        const opened = await withRecovery(ctx, "login", () => openSession(ctx, profileBrowser, profile.contextOptions, project, spec));
        if (!opened) {
          ctx.log("orchestrator", "warn", `Skipping ${role.name} on ${profile.name}: could not establish session`);
          continue;
        }
        const browserCtx = opened.browserCtx;
        ctx.log("orchestrator", "step", `=== ${profile.name} · Role: ${role.name} ===`);
        await withRecovery(ctx, "ui-audit", () => uiAuditAgent(ctx, browserCtx, role, mission.sampleSize, profile.name));
        await withRecovery(ctx, "a11y", () => a11yAgent(ctx, browserCtx, role, mission.sampleSize, profile.name));
        await withRecovery(ctx, "perf", () => perfAgent(ctx, browserCtx, role, mission.sampleSize, profile.name));
        await withRecovery(ctx, "visual", () => visualAgent(ctx, browserCtx, project.id, role, mission.sampleSize, profile.name));
        await ctx.stopTrace(browserCtx, `${role.name}-${profile.name}`);
        await browserCtx.close();
      }
    }

    // Deterministic post-discovery analysis over what the crawl captured (no
    // browser, once per run): API response sanity (R4) and analytics coverage (R7).
    await withRecovery(ctx, "api-validation", async () => apiValidationAgent(ctx));
    await withRecovery(ctx, "analytics", async () => analyticsAgent(ctx));

    // Lighthouse pass (V5): once per run, role-agnostic, smart/full only — see lighthouseAudit's own mode gate.
    await withRecovery(ctx, "perf", () => lighthouseAudit(ctx, mode));
    // ZAP baseline (V6): off unless ZAP=1 is set — see zapBaselineScan's own detection gate.
    await withRecovery(ctx, "security", () => zapBaselineScan(ctx, project));

    // Root-cause correlation (P7): deterministic set math over the run's failures
    // — clusters "5 pages, one broken endpoint" into a single high finding and
    // stashes clusters for the senior reviewer. No AI, no browser.
    await withRecovery(ctx, "root-cause", async () => rootCauseAgent(ctx));

    // AI layer. Budget order: reserve ~2k for the P6 senior sign-off, then (if
    // any business journeys are defined) give the journey engine 40% of the
    // remainder — business-flow coverage is the highest-value AI spend — then
    // (if acceptance criteria are defined) requirement validation gets 30% of
    // what's left, then split the rest: page-judge ~60% (vision), ai-reviewer.
    const seniorReserve = mission.useAI ? Math.min(2000, mission.aiTokenBudget) : 0;
    if (mission.useAI && sessions[0]) {
      let pool = mission.aiTokenBudget - seniorReserve;
      const hasJourneys = (project.journeys?.length ?? 0) > 0;
      const journeyBudget = hasJourneys ? Math.floor(pool * 0.4) : 0;
      if (hasJourneys) aiTokens += (await withRecovery(ctx, "journey", () => journeyAgent(ctx, sessions, project, mode, journeyBudget))) ?? 0;
      pool -= journeyBudget;
      const hasReqs = !!project.requirements?.trim();
      const reqBudget = hasReqs ? Math.floor(pool * 0.3) : 0;
      if (hasReqs) aiTokens += (await withRecovery(ctx, "requirements", () => requirementsAgent(ctx, project, reqBudget))) ?? 0;
      pool -= reqBudget;
      // AI Explorer (P5.7): free-roam wander, full mode only (heavier, like resilience/chaos).
      const explorerBudget = mode === "full" ? Math.floor(pool * 0.25) : 0;
      if (mode === "full") aiTokens += (await withRecovery(ctx, "explorer", () => explorerAgent(ctx, sessions[0].browserCtx, sessions[0].role, mode, explorerBudget))) ?? 0;
      pool -= explorerBudget;
      const judgeSpent = (await withRecovery(ctx, "page-judge", () => pageJudgeAgent(ctx, sessions[0].browserCtx, project, Math.floor(pool * 0.6)))) ?? 0;
      aiTokens += judgeSpent;
      aiTokens += (await withRecovery(ctx, "ai-reviewer", () => aiReviewerAgent(ctx, project, pool - judgeSpent))) ?? 0;
    }

    // Regression runs last so it diffs the complete set of this run's findings.
    await withRecovery(ctx, "regression", async () => regressionAgent(ctx, project));
  } finally {
    for (const s of sessions) {
      await ctx.stopTrace(s.browserCtx, s.role.name);
      await s.browserCtx.close();
    }
    for (const b of browserByEngine.values()) await b.close();
  }

  const findings = listFindings(runId);
  const crit = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  // ponytail: gate on critical/high only — low/medium are advisory, not run failures.
  const status = crit > 0 || high > 0 ? "failed" : "passed";
  const report = buildRunReport({
    attempted: specs.map((s) => ({ role: s.role.name })),
    established: sessions.map((s) => s.role.name),
    pages: ctx.pages,
    findings,
    missionAgents: mission.agents,
    agentsRan: [...ctx.agentsRan],
  });
  report.coverageTotals = computeCoverageTotals(ctx.pages, ctx.testedUrls, ctx.coverage); // P4
  report.coverageMatrix = buildCoverageMatrix(ctx.pages, ctx.tested, ctx.pageTypes); // V4
  if (ctx.patterns) report.patterns = ctx.patterns; // P2
  if (ctx.traces.length) report.traces = ctx.traces; // V1
  if (ctx.lighthouse.length) report.lighthouse = ctx.lighthouse; // V5
  if (regressionFocus) report.regressionFocus = regressionFocus; // V8
  // Code-aware root cause (Plan-v6 V7): repo-connected AI pass over the worst
  // findings — probable file:line + cause + suggested fix, keyed by fingerprint.
  if (mission.useAI && project.repoPath.trim()) {
    const rc = await withRecovery(ctx, "root-cause", () => codeRootCause(ctx, project, findings, Math.min(4000, mission.aiTokenBudget)));
    if (rc?.hints.length) report.rootCauseHints = rc.hints;
    aiTokens += rc?.tokens ?? 0;
  }
  // Senior QA sign-off (P6): one AI pass over the assembled report — mutates
  // report.seniorReview in place before serialization. No browser needed; its
  // info finding lands after the report's finding counts (meta, info severity —
  // never flips pass/fail).
  if (mission.useAI && sessions.length) {
    aiTokens += (await withRecovery(ctx, "senior-review", () => seniorReviewerAgent(ctx, project, report, Math.min(2000, mission.aiTokenBudget)))) ?? 0;
  }
  const okCount = report.sessions.filter((s) => s.ok).length;
  const headline = `${findings.length} findings (${crit} critical, ${high} high) across ${ctx.pages.length} pages, ${okCount}/${report.sessions.length} session(s) established.`;
  const sessionLines = report.sessions.slice(0, 8).map((s) => `${s.ok ? "✓" : "✗"} ${s.role} — ${s.detail}`);
  const summary = [headline, ...sessionLines, ...digestLines(findings)].join("\n");
  updateRun(runId, { status, finishedAt: new Date().toISOString(), summary, aiTokens, reportJson: JSON.stringify(report) });
  ctx.log("orchestrator", status === "passed" ? "pass" : "fail", headline);
}

/**
 * Pure builder for the structured run report (Plan-v3 Fix C) — answers "what
 * was actually tested?". Failed sessions quote the role's login finding (which
 * itself quotes the site's error banner), so the report says WHY coverage is
 * missing, not just that it is. Selftested.
 */
export function buildRunReport(input: {
  attempted: { role: string }[];
  established: string[];
  pages: { role: string }[];
  findings: { agent: string; role: string | null; detail: string }[];
  missionAgents: string[];
  agentsRan: string[];
}): RunReport {
  const est = new Set(input.established);
  const pagesByRole = new Map<string, number>();
  for (const p of input.pages) pagesByRole.set(p.role, (pagesByRole.get(p.role) ?? 0) + 1);
  const findingsByRole = new Map<string, number>();
  for (const f of input.findings) if (f.role) findingsByRole.set(f.role, (findingsByRole.get(f.role) ?? 0) + 1);

  const sessions: RunReportSession[] = input.attempted.map(({ role }) => {
    if (est.has(role)) return { role, ok: true, detail: `${pagesByRole.get(role) ?? 0} page(s) tested` };
    const why = input.findings.find((f) => f.agent === "login" && f.role === role);
    return { role, ok: false, detail: (why?.detail ?? "could not establish a session").split("\n")[0].slice(0, 200) };
  });
  // Sessions not in the attempted list (the anonymous fallback) still count as coverage.
  for (const role of input.established) {
    if (!input.attempted.some((a) => a.role === role)) {
      sessions.push({ role, ok: true, detail: `${pagesByRole.get(role) ?? 0} page(s) tested (public surface only — fallback)` });
    }
  }

  const coverage = [...est].map((role) => ({
    role,
    pagesTested: pagesByRole.get(role) ?? 0,
    findings: findingsByRole.get(role) ?? 0,
  }));

  const ran = new Set(input.agentsRan);
  const SKIP_REASON: Record<string, string> = {
    permissions: "needs 2+ logged-in roles",
    register: "signup flow did not run",
    crud: "full mode + non-production only",
    resilience: "full mode only",
    chaos: "full mode only",
    journey: "no business journeys defined / AI off",
    requirements: "no acceptance criteria defined / AI off",
    explorer: "full mode + AI only",
    "file-upload": "no sample file configured / production",
    "email-flows": "no test inbox + role email configured",
    "memory-leak": "full mode only",
    "api-validation": "no JSON API responses captured",
    analytics: "no analytics beacons observed",
    "root-cause": "no failures to correlate",
    "page-judge": "AI layer did not run",
    "ai-reviewer": "AI layer did not run",
    "senior-review": "AI layer did not run",
  };
  const agentsSkipped = input.missionAgents
    .filter((a) => !ran.has(a))
    .map((name) => ({
      name,
      reason: input.established.length === 0 ? "no session was established" : SKIP_REASON[name] ?? "not reached in this run",
    }));

  return { sessions, coverage, agentsRan: input.missionAgents.filter((a) => ran.has(a)), agentsSkipped };
}

/**
 * Honest coverage ratios (Plan-v4 P4) — discovered vs actually tested, over the
 * only things a black-box tester can count: pages, URL templates, controls.
 * Pure — selftested. No invented denominators.
 */
export function computeCoverageTotals(
  pages: { url: string }[],
  testedUrls: Set<string>,
  coverage: { controlsSeen: number; controlsClicked: number; journeysDefined: number; journeysPassed: number }
): CoverageTotals {
  const tpl = (u: string): string => { try { return urlTemplate(u); } catch { return u; } };
  const discovered = new Set(pages.map((p) => p.url));
  return {
    pagesDiscovered: discovered.size,
    pagesTested: testedUrls.size,
    templatesDiscovered: new Set([...discovered].map(tpl)).size,
    templatesTested: new Set([...testedUrls].map(tpl)).size,
    controlsSeen: coverage.controlsSeen,
    controlsClicked: coverage.controlsClicked,
    journeysDefined: coverage.journeysDefined,
    journeysPassed: coverage.journeysPassed,
  };
}

// V4 coverage matrix: which agent covers which dimension. "api" is deliberately
// not a column here — api-mapper/api-validation report on the run's whole API
// surface (ctx.apiCalls), not per triggering page, so there's no honest way to
// attribute an endpoint hit to one URL template without inventing data.
const DIMENSION_BY_AGENT: Record<string, string> = {
  "route-health": "functional", interaction: "functional", crud: "functional", journey: "functional",
  "form-validation": "forms", a11y: "a11y", visual: "visual", security: "security", perf: "perf", seo: "seo",
};
const COVERAGE_DIMENSIONS = ["functional", "forms", "a11y", "visual", "security", "perf", "seo"];

/**
 * Route × dimension coverage matrix (Plan-v6 V4) — rows are URL templates (114
 * sibling pages collapse to one row), columns are the dimensions above. A cell
 * is "tested" if any page matching that template was touched by an agent in
 * that dimension. Answers "what was actually tested overall", the way the live
 * view (V2/V3) answers "what is happening right now". Pure — selftested.
 */
export function buildCoverageMatrix(
  pages: { url: string }[],
  tested: Map<string, Set<string>>,
  pageTypes: Map<string, string>
): CoverageMatrix {
  const tpl = (u: string): string => { try { return urlTemplate(u); } catch { return u; } };
  const urlsByTemplate = new Map<string, string[]>();
  for (const p of pages) {
    const t = tpl(p.url);
    const list = urlsByTemplate.get(t);
    if (list) list.push(p.url); else urlsByTemplate.set(t, [p.url]);
  }

  const rows: CoverageMatrixRow[] = [...urlsByTemplate.entries()].map(([template, urls]) => {
    const testedDims: Record<string, boolean> = {};
    for (const dim of COVERAGE_DIMENSIONS) {
      testedDims[dim] = urls.some((u) => {
        const agents = tested.get(u);
        return !!agents && [...agents].some((a) => DIMENSION_BY_AGENT[a] === dim);
      });
    }
    const notTestedBy = COVERAGE_DIMENSIONS.filter((d) => !testedDims[d]);
    return { template, pageType: pageTypes.get(urls[0]) ?? null, tested: testedDims, notTestedBy };
  });
  rows.sort((a, b) => b.notTestedBy.length - a.notTestedBy.length || a.template.localeCompare(b.template));

  return {
    dimensions: COVERAGE_DIMENSIONS,
    rows,
    templatesFullyCovered: rows.filter((r) => r.notTestedBy.length === 0).length,
    templatesTotal: rows.length,
  };
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

/**
 * Human-readable digest: dedupes findings that are the same issue observed on
 * multiple browsers/pages (title minus the "[Browser] " prefix), then lists the
 * top distinct issues by severity with an occurrence count.
 */
function digestLines(findings: { severity: keyof typeof SEVERITY_RANK; title: string }[]): string[] {
  if (findings.length === 0) return [];
  const groups = new Map<string, { severity: keyof typeof SEVERITY_RANK; count: number }>();
  for (const f of findings) {
    const title = f.title.replace(/^\[[^\]]+\]\s*/, "");
    const g = groups.get(title);
    if (!g) groups.set(title, { severity: f.severity, count: 1 });
    else { g.count++; if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[g.severity]) g.severity = f.severity; }
  }
  const top = [...groups.entries()]
    .sort((a, b) => SEVERITY_RANK[a[1].severity] - SEVERITY_RANK[b[1].severity] || b[1].count - a[1].count)
    .slice(0, 8);
  const lines = top.map(([title, g]) => `• [${g.severity}] ${title}${g.count > 1 ? ` — seen ${g.count}×` : ""}`);
  const rest = groups.size - top.length;
  if (rest > 0) lines.push(`…and ${rest} more distinct issue(s).`);
  return [`Top issues (${groups.size} distinct):`, ...lines];
}

/** Creates the run row synchronously and executes in the background — returns immediately. */
export function startRun(project: Project, mode: RunMode = "quick"): string {
  const runId = nanoid();
  // planMission is a pure heuristic — cheap to compute again inside executeRun rather
  // than threading it through, but the live timeline needs the agent list up front.
  const missionAgents = planMission(project, mode).agents;
  createRun({ id: runId, projectId: project.id, mode, status: "running", startedAt: new Date().toISOString(), finishedAt: null, summary: null, missionAgents });
  void executeRun(runId, project, mode).catch((e) => {
    updateRun(runId, { status: "error", finishedAt: new Date().toISOString(), summary: `Run crashed: ${String(e).slice(0, 300)}` });
  });
  return runId;
}

/** Same as startRun but resolves only once the run reaches a terminal status — for the CLI. */
export async function runProject(project: Project, mode: RunMode = "quick"): Promise<string> {
  const runId = startRun(project, mode);
  for (;;) {
    const r = getRun(runId);
    if (r && r.status !== "running") return runId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
