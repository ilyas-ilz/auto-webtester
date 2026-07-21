export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface RoleCred {
  id: string;
  name: string; // e.g. "Admin", "Job Seeker"
  username: string;
  password: string;
}

export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  envTag: "localhost" | "staging" | "production";
  loginPath: string; // e.g. /login
  registerPath: string; // e.g. /signup — "" disables the self-registration agent
  testInboxUrl: string; // Mailpit/MailHog base URL for OTP/verify-link reads — "" = no inbox
  sessionState: string; // Playwright storageState JSON for OAuth-only sites — "" = none
  notes: string; // free-text prompt: what to focus on
  requirements: string; // free-text acceptance criteria (one per line) for the requirement-validation agent (Plan-v5 R1) — "" disables it
  uploadFilePath: string; // absolute path to a local file the file-upload agent submits into any file input (Plan-v5 R5) — "" disables it
  repoPath: string; // local checkout of the target app's source (Plan-v6 V7/V8) — "" = black-box mode, code-aware features off
  roles: RoleCred[]; // may be empty — anonymous/public-surface testing
  journeys: Journey[]; // user-defined business flows for the AI journey engine (P5) — may be empty
  createdAt: string;
}

// ---- Business journeys (Plan-v4 P5) ----
// A journey is a named business flow the AI journey engine drives end to end.
// Each step is plain natural language scoped to a role; cross-role steps (an
// Employer step followed by a Jobseeker step) are the multi-user testing path.

export type JourneyPersona = "keyboard-only" | "mobile" | "slow-network";

export interface JourneyStep {
  role: string; // must match a project role name; the Executor switches to that role's session
  text: string; // e.g. "Create a job posting titled QA-BOT {tag}"
  expect?: string; // optional per-step assertion (Plan-v5 R6): observable text expected on the page after the step — the Verifier checks it. A cross-role step with `expect` is the black-box cross-user-sync check ("Jobseeker should now see QA-BOT {tag}").
}

export interface Journey {
  name: string;
  goal: string; // what "done" looks like — the Verifier checks for its words on the final page
  steps: JourneyStep[];
  maxActions?: number; // hard stop on Navigator↔Executor iterations (default 30)
  persona?: JourneyPersona; // optional Executor behavior change (P5.1b)
}

export type RunMode = "quick" | "smart" | "full";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface Run {
  id: string;
  projectId: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  aiTokens: number;
  reportJson: string | null; // serialized RunReport, filled when the run finishes
  missionAgents: string[]; // the Mission Planner's full agent list, known before the run starts — feeds the live timeline's queued state (V3)
  commitSha: string | null; // target repo's HEAD at run time (V8) — null when no repoPath / not a git repo
}

// ---- Structured run report (Plan-v3 Fix C) ----
// Answers "what was actually tested?": which roles got sessions (and why the
// others didn't, quoting the site's own login error), how many pages/findings
// per role, and which agents ran vs were skipped.

export interface RunReportSession {
  role: string;
  ok: boolean;
  detail: string; // "12 page(s) tested" | 'site said: "Invalid email or password"'
}

export interface RunReport {
  sessions: RunReportSession[];
  coverage: { role: string; pagesTested: number; findings: number }[];
  agentsRan: string[];
  agentsSkipped: { name: string; reason: string }[];
  coverageTotals?: CoverageTotals; // discovered-vs-tested ratios (Plan-v4 P4)
  patterns?: RunPatterns; // multi-run recurrence/flakiness (Plan-v4 P2)
  seniorReview?: SeniorReview; // AI executive sign-off (Plan-v4 P6)
  traces?: { label: string; path: string }[]; // Playwright trace .zip per browser context (V1)
  coverageMatrix?: CoverageMatrix; // route × dimension coverage, with explicit "not tested" (V4)
  lighthouse?: LighthouseResult[]; // one entry per audited representative page (V5)
  rootCauseHints?: RootCauseHint[]; // AI-located probable source of the worst findings (V7) — only when repoPath is set
  regressionFocus?: RegressionFocus; // routes prioritized because their files changed in git since the last run (V8)
}

/** Probable source location of a finding (Plan-v6 V7) — AI-matched against the project's own repo. */
export interface RootCauseHint {
  findingFingerprint: string; // joins the hint to its finding in the UI
  file: string; // repo-relative path
  line: number | null;
  cause: string;
  suggestedFix: string;
  confidence: number; // hints under 0.5 are dropped at the source, never shown
}

/** Why some routes got extra attention this run (Plan-v6 V8): their files changed since the last run's commit. */
export interface RegressionFocus {
  commitSha: string;
  previousSha: string;
  changedFiles: number;
  paths: string[]; // pathnames boosted via the hotPaths sampling bonus
}

/** Lighthouse lab audit of one representative page (V5) — perf agent's Chrome, not the fleet's. */
export interface LighthouseResult {
  url: string;
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number }; // 0-100
  lcpMs: number | null; // Largest Contentful Paint
  cls: number | null; // Cumulative Layout Shift
  tbtMs: number | null; // Total Blocking Time — lab proxy for responsiveness; Lighthouse lab runs don't measure INP (that's field-only/CrUX)
}

/** One URL template's coverage across dimensions (V4) — e.g. 114 /surah/:n pages collapse to one row. */
export interface CoverageMatrixRow {
  template: string;
  pageType: string | null;
  tested: Record<string, boolean>; // dimension → was any page matching this template touched by an agent in that dimension
  notTestedBy: string[]; // dimension names with no coverage on this template
}

export interface CoverageMatrix {
  dimensions: string[];
  rows: CoverageMatrixRow[];
  templatesFullyCovered: number;
  templatesTotal: number;
}

/** Honest discovered-vs-tested ratios — only things a black-box tester can actually count (P4). */
export interface CoverageTotals {
  pagesDiscovered: number;
  pagesTested: number;
  templatesDiscovered: number;
  templatesTested: number;
  controlsSeen: number;
  controlsClicked: number;
  journeysDefined?: number; // business flows defined (P5) — omitted/0 when none
  journeysPassed?: number;
}

/** Senior QA executive summary (P6) — business-risk-ordered, written by one AI pass over the whole run. */
export interface SeniorReview {
  executive_summary: string;
  fix_first: { title: string; why_business_impact: string }[]; // ≤3, ordered by business impact
  watchlist: string[];
}

/** A set of failures sharing one cause (P7) — same failing endpoint or console error across pages. */
export interface RootCauseCluster {
  kind: "api" | "console";
  signature: string; // "GET /api/user/:n" or the normalized console line
  pages: string[]; // member page URLs
  detail: string;
}

/** What keeps happening across runs (P2). Populated by the regression agent from finding history. */
export interface RunPatterns {
  recurrent: { title: string; runsSeen: number; totalRuns: number }[]; // seen in ≥3 of last N finished runs
  reappeared: { title: string }[]; // absent last run but present in an older run — a regression
}

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  agent: string; // "login" | "crawler" | "security" | "a11y" | "perf" | "ai-reviewer" | "orchestrator"
  level: "step" | "pass" | "fail" | "warn" | "shot" | "status" | "agent-start" | "agent-done";
  message: string;
  data: string | null; // JSON payload (e.g. screenshot path, or agent-done's { durationMs, findings })
}

export type FindingKind = "bug" | "improvement";
export type FindingSource = "deterministic" | "ai" | "zap";

export interface Finding {
  id: number;
  runId: string;
  agent: string;
  severity: Severity;
  kind: FindingKind;
  source: FindingSource;
  confidence: number; // deterministic ~1.0, AI varies
  title: string;
  detail: string;
  pageUrl: string | null;
  role: string | null;
  evidence: string | null; // screenshot path or raw data JSON
  fingerprint: string;
}

// ---- Knowledge graph (Plan-v2 §3.3) ----
// Kept lean on purpose: Page + Api node types with navigates_to/calls edges.
// Feature/Entity/State/Workflow modeling is deferred — real value (route map,
// API surface, risk order) without building a full semantic model up front.

export type GraphNodeType = "page" | "api";

export interface GraphNode {
  id: number;
  projectId: string;
  type: GraphNodeType;
  key: string; // pathname for page, "METHOD /path" for api
  label: string;
  riskScore: number;
  attrs: Record<string, unknown>;
  lastSeenRun: string;
}

export type GraphEdgeType = "navigates_to" | "calls";

export interface GraphEdge {
  id: number;
  projectId: string;
  fromNode: number;
  toNode: number;
  type: GraphEdgeType;
}

// ---- Site profile (what kind of site is this?) ----
// Produced once per run by the site-classifier agent; downstream agents and
// the AI reviewer use it to reason about what "correct" looks like here.

export type SiteKind = "static" | "content" | "spa" | "saas" | "ecommerce";

export interface SiteProfile {
  kind: SiteKind;
  framework: string | null; // e.g. "next.js", "WordPress 6.4"
  hasAuth: boolean;
  hasMedia: boolean;
  signals: string[]; // human-readable evidence for the verdict
}

// ---- Mission Planner (Plan-v2 §3.1) ----
// Heuristic only for now — no LLM required to scope a run. AI involvement is
// limited to the optional aiReviewer verification pass (see planner.ts).

export interface Mission {
  agents: string[];
  useAI: boolean;
  sampleSize: number;
  profiles: string[]; // device/browser profile names (see runner/devices.ts) — [0] is always the primary
  aiTokenBudget: number; // cost guardrail (§5.1 budget.aiTokens) — 0 when useAI is false
  reason: string;
}
