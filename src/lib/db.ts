import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { Project, Run, RunEvent, RunQuestion, Finding, RoleCred, GraphNode, GraphEdge, GraphNodeType, Journey } from "./types";
import { encrypt, decrypt } from "./crypto";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "webtester.db"));
db.pragma("journal_mode = WAL");
// P0-4/P2-2 (WEBTESTER-AUDIT): enforce the REFERENCES clauses that were previously
// declarative-only. Safe to enable now that deletion is guarded + transactional —
// a late write against a deleted run now fails loudly instead of orphaning rows.
db.pragma("foreign_keys = ON");

// P0-1 (WEBTESTER-AUDIT): initial CREATE TABLEs carry the FULL current schema so a
// fresh database is complete in one shot. The addColumn() calls below remain for
// upgrading databases created before each column existed (duplicate-column swallowed).
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  env_tag TEXT NOT NULL,
  login_path TEXT NOT NULL DEFAULT '/login',
  notes TEXT NOT NULL DEFAULT '',
  roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  register_path TEXT NOT NULL DEFAULT '',
  test_inbox_url TEXT NOT NULL DEFAULT '',
  session_state TEXT NOT NULL DEFAULT '',
  journeys_json TEXT NOT NULL DEFAULT '[]',
  requirements TEXT NOT NULL DEFAULT '',
  upload_file_path TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  ai_tokens INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  mission_agents_json TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  human_takeover_at TEXT,
  heartbeat_at TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  page_url TEXT,
  role TEXT,
  evidence TEXT,
  kind TEXT NOT NULL DEFAULT 'bug',
  source TEXT NOT NULL DEFAULT 'deterministic',
  confidence REAL NOT NULL DEFAULT 1.0,
  fingerprint TEXT NOT NULL DEFAULT '',
  after_human INTEGER NOT NULL DEFAULT 0,
  fingerprint_v INTEGER NOT NULL DEFAULT 1,
  owasp TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS graph_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  last_seen_run TEXT NOT NULL,
  UNIQUE(project_id, type, key)
);
CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_node INTEGER NOT NULL REFERENCES graph_nodes(id),
  to_node INTEGER NOT NULL REFERENCES graph_nodes(id),
  type TEXT NOT NULL,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 1.0,
  UNIQUE(project_id, from_node, to_node, type)
);
CREATE TABLE IF NOT EXISTS contracts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  expected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, kind, subject)
);
CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  entity_type TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  UNIQUE(project_id, entity_type, action, from_status, to_status, actor_role)
);
CREATE TABLE IF NOT EXISTS run_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experience (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'site',
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  run_count INTEGER NOT NULL DEFAULT 1,
  success_count INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  contradicted_at INTEGER,
  UNIQUE(origin, kind, subject, predicate, object)
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  finding_fingerprint TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(origin, finding_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_questions_run ON run_questions(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_id);
`);

// ponytail: additive migrations for columns introduced after first ship.
// better-sqlite3 throws synchronously on a duplicate column — swallow that one case.
function addColumn(table: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (e) {
    if (!String(e).includes("duplicate column")) throw e;
  }
}
addColumn("runs", "ai_tokens INTEGER NOT NULL DEFAULT 0");
addColumn("runs", "report_json TEXT");
addColumn("findings", "kind TEXT NOT NULL DEFAULT 'bug'");
addColumn("findings", "source TEXT NOT NULL DEFAULT 'deterministic'");
addColumn("findings", "confidence REAL NOT NULL DEFAULT 1.0");
// graph_edges relationship-ready (Plan-v7 §3.3): per-edge facts + confidence, so
// typed relationships (created_by/belongs_to/applied_to) carry ownership/effect data.
addColumn("graph_edges", "attrs_json TEXT NOT NULL DEFAULT '{}'");
addColumn("graph_edges", "confidence REAL NOT NULL DEFAULT 1.0");
addColumn("findings", "fingerprint TEXT NOT NULL DEFAULT ''");
addColumn("projects", "register_path TEXT NOT NULL DEFAULT ''");
addColumn("projects", "test_inbox_url TEXT NOT NULL DEFAULT ''");
addColumn("projects", "session_state TEXT NOT NULL DEFAULT ''");
addColumn("projects", "journeys_json TEXT NOT NULL DEFAULT '[]'");
addColumn("projects", "requirements TEXT NOT NULL DEFAULT ''");
addColumn("projects", "upload_file_path TEXT NOT NULL DEFAULT ''");
addColumn("runs", "mission_agents_json TEXT NOT NULL DEFAULT '[]'");
addColumn("projects", "repo_path TEXT NOT NULL DEFAULT ''");
addColumn("runs", "commit_sha TEXT");
// Stop button (cross-process on purpose: the UI's server action and the run loop
// may live in different processes for CLI runs — a db flag works for both).
addColumn("runs", "cancel_requested INTEGER NOT NULL DEFAULT 0");
// Evidence provenance for the interactive live view: the moment a human takes the
// wheel, the page state stops being purely the app's doing, so findings recorded
// from then on carry the flag and the report says so. Stamped once, never cleared —
// "a human touched this run" is not undone by handing control back.
addColumn("runs", "human_takeover_at TEXT");
addColumn("findings", "after_human INTEGER NOT NULL DEFAULT 0");
// Plan-v8 §1.2 poison-guard: an experience row whose evidence was contradicted by a
// later run decays instead of climbing in trust forever — see experience.ts.
addColumn("experience", "contradicted_at INTEGER");
// Plan-v8 §3.2: fingerprint normalization changes existing hashes. Findings written
// before this shipped carry fingerprint_v=1 (raw fingerprint); regression.ts skips
// cross-version diffs instead of reporting every old finding as spuriously "new".
addColumn("findings", "fingerprint_v INTEGER NOT NULL DEFAULT 1");
// Plan-v8 §6.1: OWASP Top 10 2021 category tags, JSON string[] — a finding can map
// to more than one category (e.g. a weak session cookie is both A02 and A05).
addColumn("findings", "owasp TEXT NOT NULL DEFAULT '[]'");
// Liveness beat written by the process actually executing the run (see touchRun).
addColumn("runs", "heartbeat_at TEXT");

// P0-1: this index needs findings.fingerprint, which on a pre-migration database
// only exists after the addColumn() above ran — so it must be created here, not in
// the initial batch (that ordering broke every fresh-clone startup).
db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint)`);

/**
 * How long a run may go without a heartbeat before another process may declare it
 * dead. Generous on purpose: the beat is cheap and frequent, so a gap this large
 * means the executing process is genuinely gone, not merely busy on a slow page.
 */
export const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

/** True when a run with this last-beat (or start time, pre-heartbeat rows) is abandoned. Pure — selftested. */
export function isRunAbandoned(lastBeatIso: string | null, startedAtIso: string, nowMs: number): boolean {
  const last = Date.parse(lastBeatIso ?? startedAtIso);
  if (Number.isNaN(last)) return false; // unparseable timestamp: never destroy a run on a guess
  return nowMs - last > STALE_HEARTBEAT_MS;
}

// Reconcile orphaned runs on startup. A run executes only inside the process
// that started it (startRun → void executeRun). A dev-server restart, a crash,
// or a killed CLI leaves its row stuck at 'running'/'queued' forever with nothing
// left to finish it — the UI then shows a perpetual "RUNNING".
//
// Liveness is decided by HEARTBEAT, not by age. The previous rule ("older than 30
// minutes must be dead") was wrong on real targets: a 5-role full run against a
// remote SaaS exceeds 30 minutes easily, so merely starting a second process —
// `npm run dev`, the CLI, a bench run — declared a healthy run dead. That is not
// cosmetic: `runProject` polls this status and returns as soon as it stops being
// 'running', so the caller believed the run had finished and exited the process,
// killing the live fleet mid-flight and losing everything it had learned.
db.prepare(
  `UPDATE runs SET status='error', finished_at=?,
     summary='Interrupted — the process running this test ended before it finished (orphaned run, cleaned up on startup).'
   WHERE status IN ('running','queued') AND COALESCE(heartbeat_at, started_at) < ?`
).run(new Date().toISOString(), new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString());

// ---- projects ----

function encryptRoles(roles: RoleCred[]): string {
  return JSON.stringify(roles.map((r) => ({ ...r, password: encrypt(r.password) })));
}

function decryptOptional(blob: string): string {
  if (!blob) return "";
  try {
    return decrypt(blob);
  } catch {
    return blob; // pre-encryption row — best-effort passthrough
  }
}

function decryptRoles(json: string): RoleCred[] {
  const roles = JSON.parse(json) as RoleCred[];
  return roles.map((r) => {
    try {
      return { ...r, password: decrypt(r.password) };
    } catch {
      return r; // pre-encryption row (local dev db) — best-effort passthrough
    }
  });
}

export function createProject(p: Project): void {
  db.prepare(
    `INSERT INTO projects (id, name, base_url, env_tag, login_path, register_path, test_inbox_url, session_state, notes, requirements, upload_file_path, repo_path, roles_json, journeys_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(p.id, p.name, p.baseUrl, p.envTag, p.loginPath, p.registerPath, p.testInboxUrl, p.sessionState ? encrypt(p.sessionState) : "", p.notes, p.requirements ?? "", p.uploadFilePath ?? "", p.repoPath ?? "", encryptRoles(p.roles), JSON.stringify(p.journeys ?? []), p.createdAt);
}

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    envTag: r.env_tag as Project["envTag"],
    loginPath: r.login_path as string,
    registerPath: (r.register_path as string) ?? "",
    testInboxUrl: (r.test_inbox_url as string) ?? "",
    sessionState: decryptOptional((r.session_state as string) ?? ""),
    notes: r.notes as string,
    requirements: (r.requirements as string) ?? "",
    uploadFilePath: (r.upload_file_path as string) ?? "",
    repoPath: (r.repo_path as string) ?? "",
    roles: decryptRoles(r.roles_json as string),
    journeys: parseJourneys((r.journeys_json as string) ?? "[]"),
    createdAt: r.created_at as string,
  };
}

function parseJourneys(json: string): Journey[] {
  try {
    const j = JSON.parse(json);
    return Array.isArray(j) ? (j as Journey[]) : [];
  } catch {
    return [];
  }
}

export function listProjects(): Project[] {
  return (db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Record<string, unknown>[]).map(rowToProject);
}

export function getProject(id: string): Project | null {
  const r = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToProject(r) : null;
}

/** Same as getProject but with role passwords blanked — safe to send to the client. */
export function getProjectSafe(id: string): Project | null {
  const p = getProject(id);
  return p ? { ...p, sessionState: "", roles: p.roles.map((r) => ({ ...r, password: "" })) } : null;
}

export function listProjectsSafe(): Project[] {
  return listProjects().map((p) => ({ ...p, sessionState: "", roles: p.roles.map((r) => ({ ...r, password: "" })) }));
}

/** Everything a run wrote to disk: screenshots + live frames, traces, generated reports (P1-14 subset). */
function deleteRunArtifacts(runId: string): void {
  try {
    fs.rmSync(path.join(process.cwd(), "public", "shots", runId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "public", "traces", runId), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, "reports", `${runId}.md`), { force: true });
    fs.rmSync(path.join(DATA_DIR, "reports", `${runId}.pdf`), { force: true });
  } catch { /* artifact cleanup is best-effort — DB rows are already gone */ }
}

const deleteProjectTx = db.transaction((id: string) => {
  db.prepare(`DELETE FROM findings WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`).run(id);
  db.prepare(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`).run(id);
  db.prepare(`DELETE FROM run_questions WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`).run(id);
  db.prepare(`DELETE FROM runs WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM graph_edges WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM graph_nodes WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM contracts WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM lifecycle_transitions WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
});

export function deleteProject(id: string): void {
  const runIds = (db.prepare(`SELECT id FROM runs WHERE project_id = ?`).all(id) as { id: string }[]).map((r) => r.id);
  deleteProjectTx(id);
  for (const rid of runIds) deleteRunArtifacts(rid);
  try {
    fs.rmSync(path.join(process.cwd(), "public", "baselines", id), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** True while any of the project's runs is still executing — deletion must be refused then (P0-4). */
export function hasActiveRun(projectId: string): boolean {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN ('running','queued')`).get(projectId) as { n: number };
  return r.n > 0;
}

// ---- runs ----

export function createRun(r: Omit<Run, "aiTokens" | "reportJson" | "commitSha" | "humanTakeoverAt">): void {
  db.prepare(
    `INSERT INTO runs (id, project_id, mode, status, started_at, finished_at, summary, mission_agents_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.id, r.projectId, r.mode, r.status, r.startedAt, r.finishedAt, r.summary, JSON.stringify(r.missionAgents));
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    mode: r.mode as Run["mode"],
    status: r.status as Run["status"],
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    summary: (r.summary as string) ?? null,
    aiTokens: Number(r.ai_tokens ?? 0),
    reportJson: (r.report_json as string) ?? null,
    missionAgents: JSON.parse((r.mission_agents_json as string) ?? "[]"),
    commitSha: (r.commit_sha as string) ?? null,
    humanTakeoverAt: (r.human_takeover_at as string) ?? null,
  };
}

/** Stamps the first human takeover of the live view. Later takeovers keep the first timestamp. */
export function markHumanTakeover(runId: string): void {
  db.prepare(`UPDATE runs SET human_takeover_at = ? WHERE id = ? AND human_takeover_at IS NULL`)
    .run(new Date().toISOString(), runId);
}

export function humanTookOver(runId: string): boolean {
  const r = db.prepare(`SELECT human_takeover_at AS t FROM runs WHERE id = ?`).get(runId) as { t: string | null } | undefined;
  return !!r?.t;
}

export function updateRun(id: string, fields: Partial<Pick<Run, "status" | "finishedAt" | "summary" | "aiTokens" | "reportJson" | "commitSha">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.commitSha !== undefined) { sets.push("commit_sha = ?"); vals.push(fields.commitSha); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.finishedAt !== undefined) { sets.push("finished_at = ?"); vals.push(fields.finishedAt); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); vals.push(fields.summary); }
  if (fields.aiTokens !== undefined) { sets.push("ai_tokens = ?"); vals.push(fields.aiTokens); }
  if (fields.reportJson !== undefined) { sets.push("report_json = ?"); vals.push(fields.reportJson); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Most recent non-running run across all projects — the report CLI's default target. */
export function latestFinishedRunId(): string | null {
  const row = db.prepare("SELECT id FROM runs WHERE status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function getRun(id: string): Run | null {
  const r = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

export function listRuns(projectId: string): Run[] {
  return (db.prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC`).all(projectId) as Record<string, unknown>[]).map(rowToRun);
}

export function requestCancel(runId: string): void {
  db.prepare(`UPDATE runs SET cancel_requested = 1 WHERE id = ? AND status IN ('running','queued')`).run(runId);
}

/** "I am still alive" — written by the process executing the run, read by every other process's orphan sweep. */
export function touchRun(runId: string): void {
  db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE id = ?`).run(new Date().toISOString(), runId);
}

export function isCancelRequested(runId: string): boolean {
  const r = db.prepare(`SELECT cancel_requested AS c FROM runs WHERE id = ?`).get(runId) as { c: number } | undefined;
  return !!r?.c;
}

const deleteRunTx = db.transaction((runId: string) => {
  db.prepare(`DELETE FROM findings WHERE run_id = ?`).run(runId);
  db.prepare(`DELETE FROM run_events WHERE run_id = ?`).run(runId);
  db.prepare(`DELETE FROM run_questions WHERE run_id = ?`).run(runId);
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
});

export function deleteRun(runId: string): void {
  deleteRunTx(runId);
  deleteRunArtifacts(runId);
}

// ---- questions (human-in-the-loop) ----

export function askQuestion(runId: string, agent: string, question: string): number {
  const res = db.prepare(
    `INSERT INTO run_questions (run_id, agent, question, answer, status, created_at) VALUES (?, ?, ?, NULL, 'pending', ?)`
  ).run(runId, agent, question, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function answerQuestion(id: number, answer: string): void {
  db.prepare(`UPDATE run_questions SET answer = ?, status = 'answered' WHERE id = ? AND status = 'pending'`).run(answer, id);
}

export function getQuestion(id: number): RunQuestion | null {
  const r = db.prepare(`SELECT id, run_id as runId, agent, question, answer, status, created_at as createdAt FROM run_questions WHERE id = ?`).get(id) as RunQuestion | undefined;
  return r ?? null;
}

export function expireQuestion(id: number): void {
  db.prepare(`UPDATE run_questions SET status = 'expired' WHERE id = ? AND status = 'pending'`).run(id);
}

export function listQuestions(runId: string): RunQuestion[] {
  return db.prepare(
    `SELECT id, run_id as runId, agent, question, answer, status, created_at as createdAt FROM run_questions WHERE run_id = ? ORDER BY id`
  ).all(runId) as RunQuestion[];
}

// ---- events ----

export function addEvent(e: Omit<RunEvent, "id">): number {
  const res = db.prepare(
    `INSERT INTO run_events (run_id, ts, agent, level, message, data) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(e.runId, e.ts, e.agent, e.level, e.message, e.data);
  return Number(res.lastInsertRowid);
}

const EVENT_COLS = `id, run_id as runId, ts, agent, level, message, data`;

export function listEvents(runId: string, afterId = 0): RunEvent[] {
  return db.prepare(
    `SELECT ${EVENT_COLS} FROM run_events WHERE run_id = ? AND id > ? ORDER BY id`
  ).all(runId, afterId) as RunEvent[];
}

/**
 * Events the live view derives from (current frame, narration, agent timeline).
 * A long run has thousands of rows; only these four levels drive UI state, so
 * the page ships those instead of the whole log — the log itself is paginated.
 */
export function listLiveEvents(runId: string): RunEvent[] {
  return db.prepare(
    `SELECT ${EVENT_COLS} FROM run_events
      WHERE run_id = ? AND level IN ('shot','status','agent-start','agent-done') ORDER BY id`
  ).all(runId) as RunEvent[];
}

/** Newest-first page of the raw event log. */
export function listEventsPage(runId: string, limit: number, offset: number): { rows: RunEvent[]; total: number } {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`).get(runId) as { n: number };
  const rows = db.prepare(
    `SELECT ${EVENT_COLS} FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(runId, limit, offset) as RunEvent[];
  return { rows, total: n };
}

// ---- findings ----

export function addFinding(f: Omit<Finding, "id" | "afterHuman" | "fingerprintV">): void {
  // Flagged at insert, not derived later: "was a human at the wheel by the time
  // this was seen" is exactly the question, and it needs no finding timestamps.
  db.prepare(
    `INSERT INTO findings (run_id, agent, severity, kind, source, confidence, title, detail, page_url, role, evidence, fingerprint, fingerprint_v, owasp, after_human)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(f.runId, f.agent, f.severity, f.kind, f.source, f.confidence, f.title, f.detail, f.pageUrl, f.role, f.evidence, f.fingerprint, CURRENT_FINGERPRINT_VERSION, JSON.stringify(f.owasp ?? []), humanTookOver(f.runId) ? 1 : 0);
}

// Plan-v8 §3.2: bumped when the fingerprint's normalization rule changes — lets
// regression.ts detect a hash-scheme change and skip a diff instead of reporting
// every previously-known finding as spuriously new. See feedback.ts.
export const CURRENT_FINGERPRINT_VERSION = 2;

/**
 * Carry findings from the run a resumed run picks up from, for the agents it
 * skips — otherwise the resumed run's report is missing everything the first
 * attempt already found. ponytail: an agent that ends up re-running anyway
 * (plan diverged) can duplicate a finding; the report dedupes by title.
 */
export function copyFindings(fromRunId: string, toRunId: string, agents: string[]): void {
  if (!agents.length) return;
  const marks = agents.map(() => "?").join(",");
  db.prepare(
    `INSERT INTO findings (run_id, agent, severity, kind, source, confidence, title, detail, page_url, role, evidence, fingerprint, fingerprint_v, owasp, after_human)
     SELECT ?, agent, severity, kind, source, confidence, title, detail, page_url, role, evidence, fingerprint, fingerprint_v, owasp, after_human
       FROM findings WHERE run_id = ? AND agent IN (${marks})`
  ).run(toRunId, fromRunId, ...agents);
}

const FINDING_COLS = `id, run_id as runId, agent, severity, kind, source, confidence, title, detail, page_url as pageUrl, role, evidence, fingerprint, fingerprint_v as fingerprintV, owasp, after_human as afterHuman`;
const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

type FindingRow = Omit<Finding, "afterHuman" | "owasp"> & { afterHuman: number; owasp: string };
const toFinding = (r: FindingRow): Finding => ({ ...r, afterHuman: !!r.afterHuman, owasp: JSON.parse(r.owasp || "[]") as string[] });

export function listFindings(runId: string): Finding[] {
  const rows = db.prepare(
    `SELECT ${FINDING_COLS} FROM findings WHERE run_id = ? ORDER BY ${SEVERITY_RANK}, id`
  ).all(runId) as FindingRow[];
  return rows.map(toFinding);
}

export type FindingFilter = { severities?: string[]; kind?: string; agent?: string };

/** Filtered + paginated findings. Filtering happens in SQL so the count and the
 *  page agree — a client-side filter over one page would report the wrong total. */
export function listFindingsPage(runId: string, f: FindingFilter, limit: number, offset: number): { rows: Finding[]; total: number } {
  const where = [`run_id = ?`];
  const args: unknown[] = [runId];
  if (f.severities?.length) { where.push(`severity IN (${f.severities.map(() => "?").join(",")})`); args.push(...f.severities); }
  if (f.kind) { where.push(`kind = ?`); args.push(f.kind); }
  if (f.agent) { where.push(`agent = ?`); args.push(f.agent); }
  const w = where.join(" AND ");
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${w}`).get(...args) as { n: number };
  const rows = db.prepare(
    `SELECT ${FINDING_COLS} FROM findings WHERE ${w} ORDER BY ${SEVERITY_RANK}, id LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as FindingRow[];
  return { rows: rows.map(toFinding), total: n };
}

export function countFindings(runId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE run_id = ?`).get(runId) as { n: number }).n;
}

export function findingAgents(runId: string): string[] {
  return (db.prepare(`SELECT DISTINCT agent FROM findings WHERE run_id = ? ORDER BY agent`).all(runId) as { agent: string }[]).map((r) => r.agent);
}

/** Findings from the most recent *finished* run of a project, excluding the given run — for regression diffing. */
export function previousRunFindings(projectId: string, excludeRunId: string): { runId: string; findings: Finding[] } | null {
  const row = db.prepare(
    `SELECT id FROM runs WHERE project_id = ? AND id != ? AND status IN ('passed', 'failed') ORDER BY started_at DESC LIMIT 1`
  ).get(projectId, excludeRunId) as { id: string } | undefined;
  return row ? { runId: row.id, findings: listFindings(row.id) } : null;
}

/** The most recent finished run's commit sha (V8) — the diff base for git-aware regression focus. */
export function lastFinishedCommitSha(projectId: string, excludeRunId: string): string | null {
  const row = db.prepare(
    `SELECT commit_sha FROM runs WHERE project_id = ? AND id != ? AND status IN ('passed', 'failed') AND commit_sha IS NOT NULL ORDER BY started_at DESC LIMIT 1`
  ).get(projectId, excludeRunId) as { commit_sha: string } | undefined;
  return row?.commit_sha ?? null;
}

export interface FindingHistoryRow { runsSeen: number; totalRuns: number; }

/**
 * Multi-run memory (Plan-v4 P2): for each fingerprint, how many of the last N
 * *finished* runs of this project contained it. The current (still-running) run
 * is excluded by the status filter, so this is strictly prior history — the
 * basis for "seen in 8 of the last 10 runs" and regression-pattern detection.
 * One indexed query per distinct fingerprint over the last-N run window.
 */
export function findingHistory(projectId: string, fingerprints: string[], lastN = 10): Map<string, FindingHistoryRow> {
  const out = new Map<string, FindingHistoryRow>();
  const runs = db.prepare(
    `SELECT id FROM runs WHERE project_id = ? AND status IN ('passed', 'failed') ORDER BY started_at DESC LIMIT ?`
  ).all(projectId, lastN) as { id: string }[];
  const runIds = runs.map((r) => r.id);
  if (!runIds.length) return out;
  const placeholders = runIds.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT COUNT(DISTINCT run_id) AS c FROM findings WHERE fingerprint = ? AND run_id IN (${placeholders})`);
  for (const fp of new Set(fingerprints)) {
    const { c } = stmt.get(fp, ...runIds) as { c: number };
    out.set(fp, { runsSeen: c, totalRuns: runIds.length });
  }
  return out;
}

/**
 * Adaptive sampling (Plan-v5 R3): distinct page URLs that carried any finding in
 * the last N *finished* runs of this project. Feeds a sampling bonus so areas
 * with a history of breaking get more of the limited page budget. Empty on a
 * project's first run — degrades to plain risk sampling, no special-casing.
 */
export function recentFindingUrls(projectId: string, lastN = 5): string[] {
  const runs = db.prepare(
    `SELECT id FROM runs WHERE project_id = ? AND status IN ('passed', 'failed') ORDER BY started_at DESC LIMIT ?`
  ).all(projectId, lastN) as { id: string }[];
  if (!runs.length) return [];
  const placeholders = runs.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT DISTINCT page_url FROM findings WHERE page_url IS NOT NULL AND page_url != '' AND run_id IN (${placeholders})`
  ).all(...runs.map((r) => r.id)) as { page_url: string }[];
  return rows.map((r) => r.page_url);
}

// ---- knowledge graph (Plan-v2 §3.3) ----

export function upsertGraphNode(n: Omit<GraphNode, "id">): number {
  if (n.label) {
    db.prepare(
      `INSERT INTO graph_nodes (project_id, type, key, label, risk_score, attrs_json, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, type, key) DO UPDATE SET
         label = excluded.label, risk_score = excluded.risk_score,
         attrs_json = excluded.attrs_json, last_seen_run = excluded.last_seen_run`
    ).run(n.projectId, n.type, n.key, n.label, n.riskScore, JSON.stringify(n.attrs), n.lastSeenRun);
  } else {
    // Link discovery pre-registers targets it hasn't visited yet (label
    // unknown) so an edge can point somewhere. Create the row with the key
    // as a readable placeholder if it doesn't exist — but never touch an
    // existing label, or a self-link / repeated nav link would clobber the
    // real title recorded when that page was actually crawled.
    db.prepare(
      `INSERT INTO graph_nodes (project_id, type, key, label, risk_score, attrs_json, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, type, key) DO UPDATE SET last_seen_run = excluded.last_seen_run`
    ).run(n.projectId, n.type, n.key, n.key, n.riskScore, JSON.stringify(n.attrs), n.lastSeenRun);
  }
  const row = db.prepare(`SELECT id FROM graph_nodes WHERE project_id = ? AND type = ? AND key = ?`)
    .get(n.projectId, n.type, n.key) as { id: number };
  return row.id;
}

export function upsertGraphEdge(e: Omit<GraphEdge, "id">): void {
  // Re-observing an edge updates its facts/confidence (last-write-wins; confidence
  // merging is lifecycle-learning territory, not the foundation). Older callers
  // that omit attrs/confidence get the '{}'/1.0 defaults.
  db.prepare(
    `INSERT INTO graph_edges (project_id, from_node, to_node, type, attrs_json, confidence)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, from_node, to_node, type) DO UPDATE SET
       attrs_json = excluded.attrs_json, confidence = excluded.confidence`
  ).run(e.projectId, e.fromNode, e.toNode, e.type, JSON.stringify(e.attrs ?? {}), e.confidence ?? 1.0);
}

function rowToNode(r: Record<string, unknown>): GraphNode {
  return {
    id: r.id as number,
    projectId: r.project_id as string,
    type: r.type as GraphNodeType,
    key: r.key as string,
    label: r.label as string,
    riskScore: r.risk_score as number,
    attrs: JSON.parse(r.attrs_json as string),
    lastSeenRun: r.last_seen_run as string,
  };
}

export function listGraphNodes(projectId: string, type?: GraphNodeType): GraphNode[] {
  const rows = type
    ? db.prepare(`SELECT * FROM graph_nodes WHERE project_id = ? AND type = ? ORDER BY risk_score DESC`).all(projectId, type)
    : db.prepare(`SELECT * FROM graph_nodes WHERE project_id = ? ORDER BY risk_score DESC`).all(projectId);
  return (rows as Record<string, unknown>[]).map(rowToNode);
}

export function listGraphEdges(projectId: string): GraphEdge[] {
  const rows = db.prepare(`SELECT id, project_id as projectId, from_node as fromNode, to_node as toNode, type, attrs_json as attrsJson, confidence FROM graph_edges WHERE project_id = ?`)
    .all(projectId) as (Omit<GraphEdge, "attrs"> & { attrsJson: string })[];
  return rows.map(({ attrsJson, ...e }) => ({ ...e, attrs: JSON.parse(attrsJson) }));
}

export function graphSummary(projectId: string): { pages: number; apis: number } {
  const pages = (db.prepare(`SELECT COUNT(*) as c FROM graph_nodes WHERE project_id = ? AND type = 'page'`).get(projectId) as { c: number }).c;
  const apis = (db.prepare(`SELECT COUNT(*) as c FROM graph_nodes WHERE project_id = ? AND type = 'api'`).get(projectId) as { c: number }).c;
  return { pages, apis };
}

// Behavioral contracts (Plan-v7 §3.7) — the first clean run freezes a semantic
// invariant; later runs read it back to validate as a regression oracle. Shape kept
// db-local (kind/subject/expected) so db.ts stays free of runner types; the runner maps
// kind to its ContractKind union. Upsert is idempotent — re-freezing the same invariant
// is a no-op, never a second row.
export interface StoredContract { kind: string; subject: string; expected: boolean }

export function saveContract(projectId: string, c: StoredContract): void {
  db.prepare(
    `INSERT INTO contracts (project_id, kind, subject, expected, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind, subject) DO NOTHING`,
  ).run(projectId, c.kind, c.subject, c.expected ? 1 : 0, new Date().toISOString());
}

export function getContract(projectId: string, kind: string, subject: string): StoredContract | null {
  const r = db.prepare(`SELECT kind, subject, expected FROM contracts WHERE project_id = ? AND kind = ? AND subject = ?`)
    .get(projectId, kind, subject) as { kind: string; subject: string; expected: number } | undefined;
  return r ? { kind: r.kind, subject: r.subject, expected: !!r.expected } : null;
}

// Observed lifecycle transitions accumulated across runs (Plan-v7 §3.3). The learning
// agent judges a run's transitions against a model learned from THIS history (prior
// known-good), which is what lets backward/wrong-role fire — a single run only ever sees
// the post-terminal red flag. Row shape is db-local; the runner maps it to Transition.
export interface StoredTransition { entityType: string; action: string; from: string; to: string; actorRole: string }

export function saveTransitions(projectId: string, transitions: readonly StoredTransition[]): void {
  const stmt = db.prepare(
    `INSERT INTO lifecycle_transitions (project_id, entity_type, action, from_status, to_status, actor_role)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const tx = db.transaction((rows: readonly StoredTransition[]) => {
    for (const t of rows) stmt.run(projectId, t.entityType, t.action, t.from, t.to, t.actorRole);
  });
  tx(transitions);
}

export function listTransitions(projectId: string): StoredTransition[] {
  return (db.prepare(`SELECT entity_type as entityType, action, from_status as "from", to_status as "to", actor_role as actorRole FROM lifecycle_transitions WHERE project_id = ?`)
    .all(projectId) as StoredTransition[]);
}

// ---- Cross-run experience (Plan-v8 §1) ----
// Dumb CRUD only — the merge/contradiction/promotion logic lives in runner/experience.ts.
// `origin` is the site's `new URL(baseUrl).origin`; scope='global' rows use origin=''
// (a pattern that transferred across ≥3 sites, per §2) and are recalled for every origin.

export interface ExperienceRow {
  id: number;
  origin: string;
  scope: string; // 'site' | 'global'
  kind: string; // 'fact' | 'recovery' | 'framework' | 'timing'
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  evidence: string; // JSON string[]
  runCount: number;
  successCount: number;
  lastRunId: string;
  updatedAt: number;
  contradictedAt: number | null;
}

const EXPERIENCE_COLUMNS = `id, origin, scope, kind, subject, predicate, object, confidence, source, evidence,
  run_count as runCount, success_count as successCount, last_run_id as lastRunId, updated_at as updatedAt, contradicted_at as contradictedAt`;

export function getExperienceRow(origin: string, kind: string, subject: string, predicate: string, object: string): ExperienceRow | null {
  const r = db.prepare(`SELECT ${EXPERIENCE_COLUMNS} FROM experience WHERE origin = ? AND kind = ? AND subject = ? AND predicate = ? AND object = ?`)
    .get(origin, kind, subject, predicate, object) as ExperienceRow | undefined;
  return r ?? null;
}

export function putExperienceRow(row: Omit<ExperienceRow, "id">): void {
  db.prepare(
    `INSERT INTO experience (origin, scope, kind, subject, predicate, object, confidence, source, evidence, run_count, success_count, last_run_id, updated_at, contradicted_at)
     VALUES (@origin, @scope, @kind, @subject, @predicate, @object, @confidence, @source, @evidence, @runCount, @successCount, @lastRunId, @updatedAt, @contradictedAt)
     ON CONFLICT(origin, kind, subject, predicate, object) DO UPDATE SET
       scope = excluded.scope, confidence = excluded.confidence, source = excluded.source, evidence = excluded.evidence,
       run_count = excluded.run_count, success_count = excluded.success_count, last_run_id = excluded.last_run_id,
       updated_at = excluded.updated_at, contradicted_at = excluded.contradicted_at`,
  ).run(row);
}

/** Site rows for this origin + every global-scope row, highest run_count first, capped (§1.2). */
export function listExperienceForOrigin(origin: string, limit = 200): ExperienceRow[] {
  return db.prepare(`SELECT ${EXPERIENCE_COLUMNS} FROM experience WHERE origin = ? OR scope = 'global' ORDER BY run_count DESC LIMIT ?`)
    .all(origin, limit) as ExperienceRow[];
}

/** Decay (§1.2): a row asserted exactly once, low-confidence, and stale — noise, not experience. */
export function pruneStaleExperience(origin: string, cutoffMs: number): void {
  db.prepare(`DELETE FROM experience WHERE origin = ? AND run_count = 1 AND confidence < 0.5 AND updated_at < ?`).run(origin, cutoffMs);
}

/** All site-scope recovery rows across every origin — the promotion pool for §2 global patterns. */
export function listSiteRecoveryRows(): ExperienceRow[] {
  return db.prepare(`SELECT ${EXPERIENCE_COLUMNS} FROM experience WHERE kind = 'recovery' AND scope = 'site'`).all() as ExperienceRow[];
}

/** Other rows asserting a different object for the same subject+predicate — the poison-guard's contradiction target (§1.2). */
export function listConflictingFactRows(origin: string, subject: string, predicate: string, exceptObject: string): ExperienceRow[] {
  return db.prepare(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experience WHERE origin = ? AND kind = 'fact' AND subject = ? AND predicate = ? AND object != ?`,
  ).all(origin, subject, predicate, exceptObject) as ExperienceRow[];
}

// ---- Human feedback (Plan-v8 §3) ----
// Never deleted — suppression must stay auditable. `findingFingerprint` is the
// normalized fingerprint (see feedback.ts's normalizeForFingerprint).

export interface FeedbackRow { origin: string; findingFingerprint: string; verdict: string; reason: string; createdAt: number }

export function saveFeedbackRow(row: FeedbackRow): void {
  db.prepare(
    `INSERT INTO feedback (origin, finding_fingerprint, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(origin, finding_fingerprint) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, created_at = excluded.created_at`,
  ).run(row.origin, row.findingFingerprint, row.verdict, row.reason, row.createdAt);
}

export function getFeedbackRow(origin: string, fingerprint: string): FeedbackRow | null {
  const r = db.prepare(`SELECT origin, finding_fingerprint as findingFingerprint, verdict, reason, created_at as createdAt FROM feedback WHERE origin = ? AND finding_fingerprint = ?`)
    .get(origin, fingerprint) as FeedbackRow | undefined;
  return r ?? null;
}

export function listFeedbackForOrigin(origin: string): FeedbackRow[] {
  return db.prepare(`SELECT origin, finding_fingerprint as findingFingerprint, verdict, reason, created_at as createdAt FROM feedback WHERE origin = ?`)
    .all(origin) as FeedbackRow[];
}
