#!/usr/bin/env node
/**
 * MCP server (Plan-v8 §5) — lets Claude Desktop / any MCP client orchestrate the
 * runner. Every tool is a thin wrapper over an existing function; there is no new
 * testing logic in this file, only new transport. `npm run mcp`.
 */
import { loadEnvLocal } from "./env";
loadEnvLocal();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Project, RoleCred, RunMode, Severity } from "../types";
import { createProject, getRun, listFindings, listProjects, listRuns } from "../db";
import { startRun } from "./orchestrate";
import { targetOriginAllowed } from "../originGuard";
import { recordFeedbackForFinding, type FeedbackVerdict } from "./feedback";
import { loadExperience } from "./experience";

const server = new McpServer({ name: "webtester", version: "8.0.0" });

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const errorText = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

server.registerTool(
  "run_test",
  {
    description: "Start a QA test run against a URL. Long-running — returns a runId immediately; poll get_run_status for progress.",
    inputSchema: {
      url: z.string().describe("Base URL to test, e.g. https://staging.example.com"),
      mode: z.enum(["quick", "smart", "full"]).optional().describe("Default: quick"),
      // A-7 (WEBTESTER-AUDIT): this was hardcoded to "production", which silently
      // disabled every mutating probe (CRUD, file upload, destructive journeys) for
      // ALL MCP runs — including runs against a local dev server. Now explicit, and
      // it defaults to the SAFE value rather than assuming a throwaway environment.
      envTag: z.enum(["localhost", "staging", "production"]).optional().describe("Default: production (safest — disables mutating probes). Use localhost/staging to enable CRUD and upload testing."),
      roles: z.array(z.object({ name: z.string(), username: z.string(), password: z.string() })).optional().describe("Login credentials to test as, if the site has auth"),
    },
  },
  async ({ url, mode, envTag, roles }) => {
    if (!targetOriginAllowed(url, process.env.MCP_ALLOWED_ORIGINS)) {
      return errorText(`Refused: ${url} is not an allowed target. By default only loopback URLs are allowed — set MCP_ALLOWED_ORIGINS (comma-separated origins) to widen this.`);
    }
    const project: Project = {
      id: nanoid(), name: new URL(url).hostname, baseUrl: url, envTag: envTag ?? "production",
      loginPath: "/login", registerPath: "", testInboxUrl: "", sessionState: "", notes: "", requirements: "",
      uploadFilePath: "", repoPath: "",
      roles: (roles ?? []).map((r): RoleCred => ({ id: nanoid(), name: r.name, username: r.username, password: r.password })),
      journeys: [], createdAt: new Date().toISOString(),
    };
    createProject(project);
    const runId = startRun(project, (mode as RunMode | undefined) ?? "quick");
    return text({ runId, projectId: project.id, note: "Run started in the background — call get_run_status with this runId." });
  },
);

server.registerTool(
  "get_run_status",
  { description: "Check a run's status (queued/running/passed/failed/error/cancelled) and summary.", inputSchema: { runId: z.string() } },
  async ({ runId }) => {
    const run = getRun(runId);
    if (!run) return errorText(`No such run: ${runId}`);
    return text({ id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, aiTokens: run.aiTokens });
  },
);

server.registerTool(
  "list_findings",
  { description: "List findings for a finished (or in-progress) run, optionally filtered by minimum severity.", inputSchema: { runId: z.string(), severity: z.enum(["critical", "high", "medium", "low", "info"]).optional().describe("Minimum severity — returns this and everything more severe") } },
  async ({ runId, severity }) => {
    const run = getRun(runId);
    if (!run) return errorText(`No such run: ${runId}`);
    const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const findings = listFindings(runId).filter((f) => !severity || rank[f.severity] <= rank[severity]);
    return text(findings.map((f) => ({ id: f.id, severity: f.severity, agent: f.agent, title: f.title, detail: f.detail, pageUrl: f.pageUrl, role: f.role, owasp: f.owasp, fingerprint: f.fingerprint })));
  },
);

const LOG_SOURCE_AGENT = "route-health";

server.registerTool(
  "get_console_logs",
  { description: "Browser console errors captured during the run (surfaced as route-health findings — there is no separate console-log store).", inputSchema: { runId: z.string() } },
  async ({ runId }) => {
    const run = getRun(runId);
    if (!run) return errorText(`No such run: ${runId}`);
    const logs = listFindings(runId).filter((f) => f.agent === LOG_SOURCE_AGENT && /console error/i.test(f.title));
    return text(logs.map((f) => ({ pageUrl: f.pageUrl, detail: f.detail })));
  },
);

server.registerTool(
  "get_network_logs",
  { description: "Failed network requests captured during the run (surfaced as route-health findings — there is no separate network-log store).", inputSchema: { runId: z.string() } },
  async ({ runId }) => {
    const run = getRun(runId);
    if (!run) return errorText(`No such run: ${runId}`);
    const logs = listFindings(runId).filter((f) => f.agent === LOG_SOURCE_AGENT && /failed network request/i.test(f.title));
    return text(logs.map((f) => ({ pageUrl: f.pageUrl, detail: f.detail })));
  },
);

server.registerTool(
  "capture_screenshot",
  { description: "Fetch a finding's evidence screenshot as a base64 PNG, if it has one.", inputSchema: { runId: z.string(), findingId: z.number() } },
  async ({ runId, findingId }) => {
    const finding = listFindings(runId).find((f) => f.id === findingId);
    if (!finding) return errorText(`No finding #${findingId} in run ${runId}`);
    if (!finding.evidence || !finding.evidence.startsWith("/shots/")) return errorText(`Finding #${findingId} has no screenshot evidence.`);
    // The prefix check alone is not containment: "/shots/../../.env" passes it.
    // Resolve, then require the result to still sit under public/shots.
    const shotsRoot = path.join(process.cwd(), "public", "shots");
    const filePath = path.resolve(process.cwd(), "public", `.${finding.evidence}`);
    if (!filePath.startsWith(shotsRoot + path.sep)) return errorText(`Invalid evidence path for finding #${findingId}.`);
    if (!fs.existsSync(filePath)) return errorText(`Screenshot file missing on disk: ${finding.evidence}`);
    const data = fs.readFileSync(filePath).toString("base64");
    return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
  },
);

server.registerTool(
  "approve_finding",
  {
    description: "Record a human verdict on a finding (Plan-v8 §3): confirmed/false_positive/intended. false_positive and intended suppress it (never deleted) in every future report for that site.",
    inputSchema: { runId: z.string(), findingId: z.number(), verdict: z.enum(["confirmed", "false_positive", "intended"]), reason: z.string().optional() },
  },
  async ({ runId, findingId, verdict, reason }) => {
    const result = recordFeedbackForFinding(runId, findingId, verdict as FeedbackVerdict, reason ?? "");
    if (!result.ok) return errorText(result.error);
    return text({ recorded: true, origin: result.origin, findingTitle: result.findingTitle, verdict });
  },
);

server.registerTool(
  "search_previous_runs",
  { description: "Cross-run experience (Plan-v8 §1) and run history for an origin — what previous runs learned about this site, plus their run ids/status.", inputSchema: { origin: z.string().describe("e.g. https://app.example.com") } },
  async ({ origin }) => {
    const normalizedOrigin = (() => { try { return new URL(origin).origin; } catch { return origin; } })();
    const projects = listProjects().filter((p) => { try { return new URL(p.baseUrl).origin === normalizedOrigin; } catch { return false; } });
    const runs = projects.flatMap((p) => listRuns(p.id).map((r) => ({ runId: r.id, projectId: p.id, status: r.status, startedAt: r.startedAt })));
    const experience = loadExperience(normalizedOrigin).map((r) => ({ kind: r.kind, subject: r.subject, predicate: r.predicate, object: r.object, confidence: r.confidence, runCount: r.runCount, successCount: r.successCount }));
    return text({ origin: normalizedOrigin, runs, experience });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error(e); process.exit(1); });
