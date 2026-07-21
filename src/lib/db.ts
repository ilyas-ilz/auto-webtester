import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { Project, Run, RunEvent, Finding, RoleCred, GraphNode, GraphEdge, GraphNodeType, Journey } from "./types";
import { encrypt, decrypt } from "./crypto";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "webtester.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  env_tag TEXT NOT NULL,
  login_path TEXT NOT NULL DEFAULT '/login',
  notes TEXT NOT NULL DEFAULT '',
  roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT
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
  evidence TEXT
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
  UNIQUE(project_id, from_node, to_node, type)
);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint);
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

// Reconcile orphaned runs on startup. A run executes only inside the process
// that started it (startRun → void executeRun). A dev-server restart, a crash,
// or a killed CLI leaves its row stuck at 'running'/'queued' forever with nothing
// left to finish it — the UI then shows a perpetual "RUNNING". On process start
// mark any such run OLDER THAN 30 MINUTES as errored: real runs finish in well
// under that (quick ~5 min, full ~20 min), so this never touches a genuinely
// in-flight run — even if this module is re-evaluated by a dev hot-reload.
db.prepare(
  `UPDATE runs SET status='error', finished_at=?,
     summary='Interrupted — the process running this test ended before it finished (orphaned run, cleaned up on startup).'
   WHERE status IN ('running','queued') AND started_at < ?`
).run(new Date().toISOString(), new Date(Date.now() - 30 * 60 * 1000).toISOString());

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

export function deleteProject(id: string): void {
  db.prepare(`DELETE FROM findings WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`).run(id);
  db.prepare(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`).run(id);
  db.prepare(`DELETE FROM runs WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM graph_edges WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM graph_nodes WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

// ---- runs ----

export function createRun(r: Omit<Run, "aiTokens" | "reportJson" | "commitSha">): void {
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
  };
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

export function getRun(id: string): Run | null {
  const r = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

export function listRuns(projectId: string): Run[] {
  return (db.prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC`).all(projectId) as Record<string, unknown>[]).map(rowToRun);
}

// ---- events ----

export function addEvent(e: Omit<RunEvent, "id">): number {
  const res = db.prepare(
    `INSERT INTO run_events (run_id, ts, agent, level, message, data) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(e.runId, e.ts, e.agent, e.level, e.message, e.data);
  return Number(res.lastInsertRowid);
}

export function listEvents(runId: string, afterId = 0): RunEvent[] {
  return db.prepare(
    `SELECT id, run_id as runId, ts, agent, level, message, data FROM run_events WHERE run_id = ? AND id > ? ORDER BY id`
  ).all(runId, afterId) as RunEvent[];
}

// ---- findings ----

export function addFinding(f: Omit<Finding, "id">): void {
  db.prepare(
    `INSERT INTO findings (run_id, agent, severity, kind, source, confidence, title, detail, page_url, role, evidence, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(f.runId, f.agent, f.severity, f.kind, f.source, f.confidence, f.title, f.detail, f.pageUrl, f.role, f.evidence, f.fingerprint);
}

export function listFindings(runId: string): Finding[] {
  return db.prepare(
    `SELECT id, run_id as runId, agent, severity, kind, source, confidence, title, detail, page_url as pageUrl, role, evidence, fingerprint
     FROM findings WHERE run_id = ?
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, id`
  ).all(runId) as Finding[];
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
  db.prepare(
    `INSERT OR IGNORE INTO graph_edges (project_id, from_node, to_node, type) VALUES (?, ?, ?, ?)`
  ).run(e.projectId, e.fromNode, e.toNode, e.type);
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
  return (db.prepare(`SELECT id, project_id as projectId, from_node as fromNode, to_node as toNode, type FROM graph_edges WHERE project_id = ?`)
    .all(projectId) as GraphEdge[]);
}

export function graphSummary(projectId: string): { pages: number; apis: number } {
  const pages = (db.prepare(`SELECT COUNT(*) as c FROM graph_nodes WHERE project_id = ? AND type = 'page'`).get(projectId) as { c: number }).c;
  const apis = (db.prepare(`SELECT COUNT(*) as c FROM graph_nodes WHERE project_id = ? AND type = 'api'`).get(projectId) as { c: number }).c;
  return { pages, apis };
}
