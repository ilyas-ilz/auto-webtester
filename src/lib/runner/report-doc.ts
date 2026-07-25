import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import type { Finding, Run, RunReport, Severity } from "../types";
import { getRun, getProject, listFindings, listEvents } from "../db";

// ---- Plain-language reference tables ------------------------------------

/** What each agent does, written for a non-engineer reading the report. */
const AGENT_PURPOSE: Record<string, string> = {
  login: "Signs in as each user role, exactly like a person typing the email and password.",
  crawler: "Walks through the site link by link to discover every reachable page for the role.",
  "site-classifier": "Works out what kind of site this is (shop, SaaS dashboard, content site...) so other checks calibrate.",
  "route-health": "Opens every discovered page and checks it loads: no server errors, no broken network calls, no console errors.",
  "api-mapper": "Lists every backend API endpoint the site called while browsing.",
  "api-validation": "Sanity-checks the JSON the backend returned (empty lists, nulls, wrong shapes).",
  analytics: "Checks whether analytics/telemetry is wired up and firing.",
  interaction: "Clicks buttons, tabs and menus, types into search/filter boxes, and plays media - then watches whether anything actually happens.",
  "page-expectations": "Checks each page contains what a page of its type should (a product page has a price, a form has a submit...).",
  "form-validation": "Fills forms with bad input on purpose to check the site validates and shows sensible errors.",
  "data-integrity": "Looks for broken data on pages: 'undefined', 'NaN', raw template code, empty lists that should have items.",
  "ui-audit": "Checks visual consistency: button colours, font sizes, heading scale.",
  visual: "Takes screenshots and compares against the previous run to catch unintended visual changes.",
  a11y: "Accessibility audit (axe-core): can people using screen readers or keyboard-only actually use this site?",
  perf: "Measures page speed (load time, Largest Contentful Paint, etc.).",
  security: "Checks cookies, headers, HTTPS usage, exposed secrets and common security misconfigurations.",
  seo: "Checks titles, descriptions, canonical URLs and other search-engine basics.",
  "root-cause": "Groups many failing pages that share one underlying broken endpoint/error into a single cause.",
  regression: "Compares this run against previous runs: what's new, what came back, what keeps flapping.",
  permissions: "Tries to open one role's pages while logged in as a different role - catches privilege leaks.",
  register: "Runs the sign-up flow as a brand-new user.",
  crud: "Creates/edits/deletes a test record to prove the basic data flows work (non-production only).",
  resilience: "Breaks the network on purpose (failing APIs, slow responses) and checks the app degrades gracefully.",
  chaos: "Random rapid clicking/typing to shake out crashes.",
  "memory-leak": "Navigates repeatedly and watches whether browser memory keeps climbing.",
  "file-upload": "Uploads a sample file into any upload control.",
  "email-flows": "Requests a password reset and reads the test inbox to verify the email arrives.",
  journey: "AI: walks user-defined business flows end to end (e.g. 'post a job, then apply to it').",
  requirements: "AI: checks the written acceptance criteria against what the site actually does.",
  explorer: "AI: free-roams the app like a curious user looking for anything odd.",
  "page-judge": "AI: looks at screenshots of pages and judges whether each looks right to a human eye.",
  "ai-reviewer": "AI: reviews the evidence for business-logic and UX problems deterministic checks can't see.",
  "senior-review": "AI: a senior-QA style sign-off - what to fix first and why it matters to the business.",
  orchestrator: "The conductor - starts agents, tracks sessions, assembles this report.",
};

/** Best-guess cause, keyed off finding content - labelled as assumption in the report. */
export function assumedCause(f: Pick<Finding, "agent" | "title" | "detail">): string {
  const t = `${f.title} ${f.detail}`.toLowerCase();
  if (/50[24]|timeout|timed out/.test(t)) return "The server took too long or gave up - usually an overloaded backend, a slow database query, or an upstream API timing out. Server logs around this run's timestamps will show the real culprit.";
  if (/csrf|cookie/.test(t)) return "The session/CSRF cookie is missing hardening flags (HttpOnly / Secure / SameSite). This is a server configuration change, usually one line in the auth setup.";
  if (/button-name|discernible text/.test(t)) return "Icon-only buttons with no accessible label - screen-reader users hear 'button' with no idea what it does. Add aria-label to each.";
  if (/color-contrast|contrast/.test(t)) return "Text colour too close to its background. A design-token tweak (darker text or lighter background) fixes whole groups at once.";
  if (/html-has-lang|<html lang|lang attribute/.test(t)) return "The page's <html> tag is missing lang=\"en\"/\"ar\" - likely one shared layout component. One-line fix, clears many pages at once.";
  if (/document-title|no <title>|missing <title>/.test(t)) return "The page never sets a title - probably a shared layout/head component not receiving a title prop for these routes.";
  if (/heading-order|level-one heading|h1/.test(t)) return "Heading structure skips levels or lacks an H1 - a template-level markup issue, not per-page content.";
  if (/landmark|region\)/.test(t)) return "Page content isn't wrapped in semantic landmarks (<main>, <nav>...) - one layout component change.";
  if (/largest contentful paint|lcp|slow/.test(t)) return "The biggest visible element renders late - commonly an unoptimised hero image or a render blocked on a slow API. Check image sizes and server response time first.";
  if (/does not search|appears to do nothing|throws a js error/.test(t)) return "The control renders but its handler is missing, broken, or crashed - often an event listener that never got attached or an exception in the click path (see the console error if quoted above).";
  if (/canonical|meta description|open graph|viewport/.test(t)) return "Missing head/meta tags - a shared SEO/head component gap, fixable centrally.";
  if (/failed network request|console error/.test(t)) return "The page depends on API calls that are failing - fix the failing endpoint(s) and these clear up together (see the root-cause section).";
  if (/session state|logged in|login/.test(t)) return "Authentication/session issue - credentials, expiry, or the login flow itself.";
  return "No single obvious cause from black-box evidence - the detail above quotes exactly what was observed; reproduce with the same role and URL to narrow it down.";
}

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const SEV_PLAIN: Record<Severity, string> = {
  critical: "Critical - blocks users or loses data; fix immediately",
  high: "High - real user-facing breakage; fix soon",
  medium: "Medium - degrades experience or quality; plan a fix",
  low: "Low - polish and best-practice gaps",
  info: "Info - context, not a defect",
};

// ---- Markdown assembly ----------------------------------------------------

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function dur(ms: number): string {
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** Dedupe findings that are the same issue seen on many pages/browsers. */
function groupFindings(findings: Finding[]): { key: Finding; title: string; count: number; pages: string[] }[] {
  const map = new Map<string, { key: Finding; title: string; count: number; pages: string[] }>();
  // Group key strips browser prefixes AND collapses URLs to route templates,
  // so "504 on /en/jobs/<id-1>" and "504 on /en/jobs/<id-2>" read as one issue.
  const tpl = (u: string): string => {
    try { return new URL(u).pathname.replace(/[0-9a-f]{12,}/gi, ":id").replace(/\d{3,}/g, ":id"); } catch { return u; }
  };
  for (const f of findings) {
    const title = f.title.replace(/^\[[^\]]+\]\s*/, "").replace(/https?:\/\/[^\s"')]+/g, tpl);
    const k = `${f.agent}|${title}`;
    const g = map.get(k);
    if (g) { g.count++; if (f.pageUrl && !g.pages.includes(f.pageUrl)) g.pages.push(f.pageUrl); }
    else map.set(k, { key: f, title, count: 1, pages: f.pageUrl ? [f.pageUrl] : [] });
  }
  return [...map.values()].sort((a, b) => SEV_ORDER.indexOf(a.key.severity) - SEV_ORDER.indexOf(b.key.severity) || b.count - a.count);
}

/** Pure builder - full Markdown report from run data. Exported for tests. */
export function buildReportMarkdown(run: Run, projectName: string, baseUrl: string, findings: Finding[], events: { agent: string; level: string; message: string }[]): string {
  const report: RunReport | null = run.reportJson ? (JSON.parse(run.reportJson) as RunReport) : null;
  const L: string[] = [];
  const roles = [...new Set([...(report?.sessions.map((s) => s.role) ?? []), ...findings.map((f) => f.role).filter((r): r is string => !!r)])];
  const started = new Date(run.startedAt), finished = run.finishedAt ? new Date(run.finishedAt) : null;
  const aiDown = events.some((e) => e.message.startsWith("AI LAYER DOWN"));
  const aiOff = events.some((e) => e.message.startsWith("AI layer OFF")) || /AI layer off/.test(events.find((e) => e.agent === "orchestrator")?.message ?? "");
  const bySev = new Map<Severity, number>();
  for (const f of findings) bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1);

  L.push(`# Test Report - ${projectName}`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Target | ${baseUrl} |`);
  L.push(`| Run | \`${run.id}\` (${run.mode} mode) |`);
  L.push(`| Started | ${started.toLocaleString()} |`);
  L.push(`| Duration | ${finished ? dur(finished.getTime() - started.getTime()) : "still running"} |`);
  L.push(`| Verdict | **${run.status.toUpperCase()}** |`);
  L.push(`| AI review layer | ${aiDown ? "WARNING: CONFIGURED BUT DOWN - deterministic checks only" : aiOff ? "off (no API key / quick mode)" : run.aiTokens > 0 ? `on (${run.aiTokens.toLocaleString()} tokens used)` : "off"} |`);
  L.push(`| Total findings | ${findings.length} (${SEV_ORDER.map((s) => `${bySev.get(s) ?? 0} ${s}`).join(", ")}) |`);
  L.push("");

  L.push(`## How to read this report`);
  L.push("");
  L.push(`A fleet of automated testing agents signed into the site as each user role, browsed every page it could reach, clicked controls, typed into forms and search boxes, and measured speed, security, accessibility and correctness. Each problem found is listed with: **what happened**, **where**, **what we think caused it** (clearly marked as an assumption), and **what to do about it**. Severity meanings:`);
  L.push("");
  for (const s of SEV_ORDER) L.push(`- **${s}**: ${SEV_PLAIN[s]}`);
  L.push("");

  // Executive summary - top deduped issues.
  const groups = groupFindings(findings.filter((f) => f.severity !== "info"));
  L.push(`## Executive summary`);
  L.push("");
  if (report?.seniorReview) {
    L.push(report.seniorReview.executive_summary);
    L.push("");
    if (report.seniorReview.fix_first.length) {
      L.push(`**Fix first:**`);
      for (const f of report.seniorReview.fix_first) L.push(`1. **${f.title}** - ${f.why_business_impact}`);
      L.push("");
    }
  }
  L.push(`The ${groups.length} distinct issues (many repeat across pages/browsers), worst first:`);
  L.push("");
  L.push(`| Severity | Issue | Found by | Seen |`);
  L.push(`|---|---|---|---|`);
  for (const g of groups.slice(0, 15)) L.push(`| ${g.key.severity} | ${esc(g.title)} | ${g.key.agent} | ${g.count}x |`);
  if (groups.length > 15) L.push(`| | ...and ${groups.length - 15} more distinct issues (full list below) | | |`);
  L.push("");

  // Sessions / what was tested.
  if (report) {
    L.push(`## Who logged in and what was covered`);
    L.push("");
    L.push(`| Role | Login | Detail |`);
    L.push(`|---|---|---|`);
    for (const s of report.sessions) L.push(`| ${s.role} | ${s.ok ? "OK - succeeded" : "FAILED"} | ${esc(s.detail)} |`);
    L.push("");
    if (report.coverageTotals) {
      const c = report.coverageTotals;
      L.push(`Coverage: **${c.pagesTested} of ${c.pagesDiscovered} discovered pages tested** (${c.templatesTested}/${c.templatesDiscovered} unique page types), **${c.controlsClicked} of ${c.controlsSeen} interactive controls clicked**.`);
      L.push("");
    }
  }

  // Per-agent activity table.
  const agentStats = new Map<string, { steps: number; pass: number; fail: number; warn: number }>();
  for (const e of events) {
    if (!["step", "pass", "fail", "warn"].includes(e.level)) continue;
    const s = agentStats.get(e.agent) ?? { steps: 0, pass: 0, fail: 0, warn: 0 };
    if (e.level === "step") s.steps++; else if (e.level === "pass") s.pass++; else if (e.level === "fail") s.fail++; else s.warn++;
    agentStats.set(e.agent, s);
  }
  const findingsByAgent = new Map<string, number>();
  for (const f of findings) findingsByAgent.set(f.agent, (findingsByAgent.get(f.agent) ?? 0) + 1);

  L.push(`## What each agent did`);
  L.push("");
  L.push(`| Agent | Job (plain language) | Activity | Findings |`);
  L.push(`|---|---|---|---|`);
  for (const [agent, s] of [...agentStats.entries()].sort()) {
    if (agent === "recorder") continue;
    L.push(`| ${agent} | ${AGENT_PURPOSE[agent] ?? "-"} | ${s.steps} steps, ${s.pass} passes, ${s.fail} fails, ${s.warn} warnings | ${findingsByAgent.get(agent) ?? 0} |`);
  }
  L.push("");
  if (report?.agentsSkipped.length) {
    L.push(`**Agents that did not run** (and why): ${report.agentsSkipped.map((a) => `${a.name} (${a.reason})`).join("; ")}.`);
    L.push("");
  }

  // Role-by-role chapters.
  for (const role of roles) {
    const rf = findings.filter((f) => f.role === role);
    const session = report?.sessions.find((s) => s.role === role);
    L.push(`## Role: ${role}`);
    L.push("");
    if (session) L.push(`Login ${session.ok ? "succeeded" : "**FAILED**"} - ${session.detail}. ${rf.length} finding(s) recorded while testing as this role.`);
    L.push("");
    const rGroups = groupFindings(rf);
    for (const sev of SEV_ORDER) {
      const sevGroups = rGroups.filter((g) => g.key.severity === sev);
      if (!sevGroups.length) continue;
      L.push(`### ${sev.toUpperCase()} (${sevGroups.length} distinct)`);
      L.push("");
      for (const g of sevGroups) {
        L.push(`**${g.title}**${g.count > 1 ? ` - seen ${g.count}x across ${g.pages.length} page(s)` : ""}`);
        L.push("");
        L.push(`- **What happened:** ${esc(g.key.detail.slice(0, 500))}`);
        if (g.pages.length) L.push(`- **Where:** ${g.pages.slice(0, 5).map((p) => `\`${p}\``).join(", ")}${g.pages.length > 5 ? ` ...and ${g.pages.length - 5} more` : ""}`);
        L.push(`- **Likely cause (assumption):** ${assumedCause(g.key)}`);
        L.push(`- **Found by:** ${g.key.agent} agent${g.key.source === "ai" ? " (AI review)" : ""}`);
        L.push("");
      }
    }
    if (!rf.length) L.push(`No problems recorded for this role.`);
    L.push("");
  }

  // Site-wide (role-less) findings.
  const siteWide = findings.filter((f) => !f.role);
  if (siteWide.length) {
    L.push(`## Site-wide findings (not tied to one role)`);
    L.push("");
    for (const g of groupFindings(siteWide)) {
      L.push(`**[${g.key.severity}] ${g.title}**${g.count > 1 ? ` - ${g.count}x` : ""}`);
      L.push("");
      L.push(`- **What happened:** ${esc(g.key.detail.slice(0, 500))}`);
      L.push(`- **Likely cause (assumption):** ${assumedCause(g.key)}`);
      L.push("");
    }
  }

  // Root-cause hints (code-aware, AI).
  if (report?.rootCauseHints?.length) {
    L.push(`## Probable code locations (AI-matched against the repo)`);
    L.push("");
    for (const h of report.rootCauseHints) L.push(`- \`${h.file}${h.line ? `:${h.line}` : ""}\` - ${h.cause} -> ${h.suggestedFix}`);
    L.push("");
  }

  L.push(`---`);
  L.push(`*Generated by webtester run \`${run.id}\`. Screenshots and Playwright traces for every step are in the run's dashboard page.*`);
  return L.join("\n");
}

// ---- Markdown -> printable HTML (only the constructs emitted above) --------

export function mdToHtml(md: string): string {
  const inline = (s: string): string => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  const lines = md.split("\n");
  let inTable = false, inList = false;
  const closeAll = (): void => { if (inTable) { out.push("</table>"); inTable = false; } if (inList) { out.push("</ul>"); inList = false; } };
  for (const line of lines) {
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
      if (!inTable) { closeAll(); out.push("<table>"); inTable = true; }
      const cells = line.slice(1, -1).split("|").map((c) => inline(c.trim().replace(/\\\|/g, "|")));
      out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`);
      continue;
    }
    if (inTable) { out.push("</table>"); inTable = false; }
    if (/^- /.test(line) || /^\d+\. /.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^(- |\d+\. )/, ""))}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (/^### /.test(line)) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (/^## /.test(line)) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (/^# /.test(line)) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (/^---+$/.test(line.trim())) out.push("<hr>");
    else if (line.trim() === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeAll();
  const css = `body{font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#1a1a2e;margin:28px;line-height:1.5}
h1{font-size:20px;border-bottom:2px solid #1a1a2e;padding-bottom:6px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #ccc;padding-bottom:3px}h3{font-size:12px;margin-top:14px}
table{border-collapse:collapse;width:100%;margin:8px 0}td{border:1px solid #ddd;padding:4px 7px;vertical-align:top}tr:first-child td{background:#f0f0f5;font-weight:600}
code{background:#f4f4f8;padding:1px 4px;border-radius:3px;font-size:10px;word-break:break-all}ul{margin:4px 0 10px 18px;padding:0}li{margin:2px 0}hr{border:none;border-top:1px solid #ccc;margin:16px 0}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${out.join("\n")}</body></html>`;
}

// ---- Entry point -----------------------------------------------------------

/** Writes data/reports/<runId>.md and .pdf. Returns paths, or null if the run doesn't exist. */
export async function generateReportDocs(runId: string): Promise<{ md: string; pdf: string | null } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const project = getProject(run.projectId);
  const findings = listFindings(runId);
  const events = listEvents(runId);
  const md = buildReportMarkdown(run, project?.name ?? run.projectId, project?.baseUrl ?? "", findings, events);

  const dir = path.join(process.cwd(), "data", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${runId}.md`);
  fs.writeFileSync(mdPath, md, "utf8");

  let pdfPath: string | null = path.join(dir, `${runId}.pdf`);
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(mdToHtml(md), { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "A4", margin: { top: "14mm", bottom: "14mm", left: "10mm", right: "10mm" }, printBackground: true });
    await browser.close();
  } catch {
    pdfPath = null; // MD is the deliverable; PDF is best-effort (no Chromium -> still fine)
  }
  return { md: mdPath, pdf: pdfPath };
}
