import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { RunContext } from "./context";
import { aiToolCall } from "./ai";
import { urlTemplate } from "./agents/crawler";
import type { Project, Finding, RootCauseHint } from "../types";

const AGENT = "root-cause";
const execFileAsync = promisify(execFile);

// ---- Plan-v6 V7/V8: the repo-connected layer -------------------------------
// Everything here is gated on project.repoPath. No repo → callers skip silently
// and black-box mode stays first-class. Pure route↔file matching is exported
// for the selftest; git + AI calls live in thin wrappers around it.

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", "vendor", ".venv", "__pycache__"]);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|java|cs)$/i;

/** Repo-relative forward-slash paths of code files, capped so a monorepo can't blow memory. */
export function listRepoFiles(repoPath: string, cap = 4000): string[] {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (files.length >= cap) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= cap) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (CODE_FILE.test(e.name)) {
        files.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(repoPath, "");
  return files;
}

/**
 * Pure — selftested. Maps a repo file to the URL route it serves, or null for
 * non-route files (components, libs). Understands Next.js app router
 * (app/**&#47;page|route.*, route groups dropped) and pages router
 * (pages/**&#47;*.tsx, index collapsed). Express-style route files have no
 * convention to parse — they fall through to the name-match heuristics.
 */
export function fileToRoute(file: string): string | null {
  const f = file.replace(/\\/g, "/").replace(/^src\//, "");
  let m = f.match(/^app\/(.*?)\/?(page|route)\.(tsx|jsx|ts|js|mjs)$/);
  if (m) {
    const segs = m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s));
    return "/" + segs.join("/");
  }
  m = f.match(/^pages\/(.*)\.(tsx|jsx|ts|js|mjs)$/);
  if (m) {
    const segs = m[1].split("/").filter(Boolean);
    if (segs[0]?.startsWith("_")) return null; // _app/_document/_error are not routes
    if (segs[segs.length - 1] === "index") segs.pop();
    return "/" + segs.join("/");
  }
  return null;
}

/**
 * Pure — selftested. Does a file-derived route serve this URL path? Dynamic
 * file segments ([id], [locale]) match any concrete or templated (:n/:id)
 * segment; catch-alls ([...slug]) absorb the rest; literals must match
 * case-insensitively. A literal file segment never serves a templated position.
 */
export function routesMatch(fileRoute: string, urlPath: string): boolean {
  const fsegs = fileRoute.split("/").filter(Boolean);
  const usegs = urlPath.split("/").filter(Boolean);
  for (let i = 0; i < fsegs.length; i++) {
    const f = fsegs[i];
    if (/^\[\[\.\.\./.test(f)) return true; // optional catch-all also serves the bare route
    if (/^\[\.\.\./.test(f)) return usegs.length > i; // required catch-all needs ≥1 segment to absorb
    const u = usegs[i];
    if (u === undefined) return false;
    if (f.startsWith("[") && f.endsWith("]")) continue;
    if (u === ":n" || u === ":id") return false;
    if (f.toLowerCase() !== u.toLowerCase()) return false;
  }
  return fsegs.length === usegs.length;
}

/**
 * Pure — selftested. Probable source files for a URL template path: route
 * convention first, then the plan's "grep fallback" — files whose path contains
 * the last literal segment. Capped at 3 so the AI prompt stays small.
 */
export function matchRouteToFiles(urlPath: string, files: string[]): string[] {
  const conventional = files.filter((f) => {
    const r = fileToRoute(f);
    return r !== null && routesMatch(r, urlPath);
  });
  if (conventional.length) return conventional.slice(0, 3);
  const literals = urlPath.split("/").filter((s) => s && !s.startsWith(":"));
  const last = literals[literals.length - 1]?.toLowerCase();
  if (!last || last.length < 3) return [];
  return files.filter((f) => f.toLowerCase().includes(last)).slice(0, 3);
}

/**
 * Pure — selftested (V8). Which known pathnames do the changed files serve?
 * Route files map via convention; component/lib files map when their basename
 * appears as a literal path segment. Files matching nothing are dropped —
 * ponytail: the plan's "global changed boost" would boost every page equally,
 * which boosts nothing; add real import-graph mapping if this proves too blunt.
 */
export function mapChangedFilesToPaths(changedFiles: string[], knownPaths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of knownPaths) {
    const hits: string[] = [];
    for (const file of changedFiles) {
      const route = fileToRoute(file);
      if (route !== null) {
        if (routesMatch(route, p)) hits.push(file);
        continue;
      }
      const base = (file.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.[a-z]+$/i, "").toLowerCase();
      if (base.length >= 4 && p.toLowerCase().split("/").includes(base)) hits.push(file);
    }
    if (hits.length) out.set(p, hits);
  }
  return out;
}

// ---- git plumbing (V8) ----

export async function currentCommitSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 10000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null; // not a git repo / git not installed — V8 silently off
  }
}

export async function changedFilesSince(repoPath: string, sha: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "diff", "--name-only", `${sha}..HEAD`], { timeout: 15000 });
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null; // unknown base sha (rebase/gc) — treat as "no diff available"
  }
}

// ---- AI root-cause pass (V7) ----

const HINT_TOOL = {
  name: "report_root_cause",
  description: "Report the probable source-code location and cause of the observed QA finding.",
  schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Repo-relative path of the file most likely responsible" },
      line: { type: ["number", "null"], description: "1-based line number if identifiable, else null" },
      cause: { type: "string", description: "One or two sentences: what in this code causes the finding" },
      suggestedFix: { type: "string", description: "Concrete change to make, one or two sentences" },
      confidence: { type: "number", description: "0..1 — how sure you are this is the real cause. Below 0.5 means you are guessing." },
    },
    required: ["file", "cause", "suggestedFix", "confidence"],
  } as Record<string, unknown>,
};

const MAX_HINT_FINDINGS = 5;
const SNIPPET_LINES = 120;

export interface CodeRootCauseResult { hints: RootCauseHint[]; tokens: number }

/**
 * Post-report step (Plan-v6 V7) — extends the root-cause stage, not a new fleet
 * agent. For the worst findings with a page URL, locate probable source files
 * in the project's own repo and ask the AI for a file:line + cause + fix, on a
 * forced tool schema. Hints below 0.5 confidence are dropped, not shown.
 */
export async function codeRootCause(ctx: RunContext, project: Project, findings: Finding[], budget: number): Promise<CodeRootCauseResult> {
  const out: CodeRootCauseResult = { hints: [], tokens: 0 };
  const repo = project.repoPath.trim();
  if (!repo || budget <= 0) return out;
  if (!fs.existsSync(repo)) {
    ctx.log(AGENT, "warn", `repoPath does not exist: ${repo} — code-aware root cause skipped.`);
    return out;
  }
  const files = listRepoFiles(repo);
  if (!files.length) return out;

  const worst = findings.filter((f) => (f.severity === "critical" || f.severity === "high") && f.pageUrl).slice(0, MAX_HINT_FINDINGS);
  for (const f of worst) {
    if (out.tokens >= budget) break;
    let tplPath: string;
    try { tplPath = new URL(urlTemplate(f.pageUrl!)).pathname; } catch { continue; }
    const matched = matchRouteToFiles(tplPath, files);
    if (!matched.length) continue;

    ctx.status(AGENT, `Locating root cause of "${f.title}" in ${matched[0]}`, { url: f.pageUrl });
    const snippets = matched.map((m) => {
      try {
        const text = fs.readFileSync(path.join(repo, m), "utf-8").split("\n").slice(0, SNIPPET_LINES)
          .map((l, i) => `${i + 1}: ${l}`).join("\n");
        return `--- ${m} ---\n${text}`;
      } catch { return `--- ${m} --- (unreadable)`; }
    }).join("\n\n").slice(0, 12000);

    try {
      const res = await aiToolCall({
        maxTokens: 600,
        tool: HINT_TOOL,
        text: `A black-box QA run against ${project.baseUrl} found this issue:\n\nSeverity: ${f.severity}\nTitle: ${f.title}\nDetail: ${f.detail.slice(0, 800)}\nPage: ${f.pageUrl}\n\nThe candidate source files serving that route (line-numbered, truncated to ${SNIPPET_LINES} lines each):\n\n${snippets}\n\nIdentify the probable root cause in this code. If the shown code cannot plausibly cause the finding, report low confidence (<0.5) — do not guess.`,
      });
      if (!res) return out; // no AI provider configured
      out.tokens += res.tokens;
      const h = res.input as { file?: unknown; line?: unknown; cause?: unknown; suggestedFix?: unknown; confidence?: unknown } | null;
      if (!h || typeof h.file !== "string" || typeof h.cause !== "string" || typeof h.confidence !== "number") continue;
      if (h.confidence < 0.5) {
        ctx.log(AGENT, "step", `Low-confidence root cause for "${f.title}" dropped (${h.confidence.toFixed(2)}) — better no answer than a guess.`);
        continue;
      }
      out.hints.push({
        findingFingerprint: f.fingerprint,
        file: h.file,
        line: typeof h.line === "number" ? h.line : null,
        cause: h.cause,
        suggestedFix: typeof h.suggestedFix === "string" ? h.suggestedFix : "",
        confidence: h.confidence,
      });
    } catch (e) {
      ctx.log(AGENT, "warn", `Root-cause AI call failed for "${f.title}": ${String(e).slice(0, 160)}`);
    }
  }
  if (out.hints.length) ctx.log(AGENT, "pass", `${out.hints.length} probable root cause(s) located in the connected repo`);
  return out;
}
