// One-off e2e verifier — creates the mployedin project with all 5 roles, runs a
// smart-mode pass, then prints per-agent activity so we can see each agent did
// real work (steps + findings), not "just a screenshot". Delete after use.
import { nanoid } from "nanoid";
import type { Project, RoleCred } from "../types";
import { createProject, listEvents, listFindings } from "../db";
import { runProject } from "./orchestrate";

const mk = (name: string, username: string, password: string): RoleCred => ({ id: nanoid(), name, username, password });

const project: Project = {
  id: nanoid(),
  name: "mployedin",
  baseUrl: "https://mployedin-8a4rc.ondigitalocean.app",
  envTag: "staging",
  loginPath: "/en/login",
  registerPath: "",
  testInboxUrl: "",
  sessionState: "",
  notes: "5-role job platform (admin / super_agent / agent / employer / job_seeker). Focus on role separation and core flows.",
  requirements: "",
  uploadFilePath: "",
  repoPath: "",
  roles: [
    mk("admin", "admin@mployedin.com", "Admin@1234"),
    mk("super_agent", "superagent@mployedin.com", "SuperAgent@1234"),
    mk("agent", "agent@mployedin.com", "Agent@1234"),
    mk("employer", "employer@mployedin.com", "Employer@1234"),
    mk("job_seeker", "jobseeker@mployedin.com", "JobSeeker@1234"),
  ],
  journeys: [],
  createdAt: new Date().toISOString(),
};

async function main(): Promise<void> {
  createProject(project);
  console.log(`\n▶ mployedin smart run starting (${project.roles.length} roles)...\n`);
  const runId = await runProject(project, "smart");

  const events = listEvents(runId);
  const findings = listFindings(runId);

  // Per-agent activity: how many steps/passes/fails/shots + findings each produced.
  const byAgent = new Map<string, { step: number; pass: number; fail: number; warn: number; shot: number; findings: number }>();
  const bump = (a: string, k: "step" | "pass" | "fail" | "warn" | "shot") => {
    const e = byAgent.get(a) ?? { step: 0, pass: 0, fail: 0, warn: 0, shot: 0, findings: 0 };
    e[k]++; byAgent.set(a, e);
  };
  for (const e of events) bump(e.agent, e.level as "step" | "pass" | "fail" | "warn" | "shot");
  for (const f of findings) { const e = byAgent.get(f.agent) ?? { step: 0, pass: 0, fail: 0, warn: 0, shot: 0, findings: 0 }; e.findings++; byAgent.set(f.agent, e); }

  console.log(`\n${"═".repeat(72)}\nPER-AGENT ACTIVITY (run ${runId})\n${"═".repeat(72)}`);
  console.log("agent".padEnd(18), "steps".padStart(6), "pass".padStart(5), "fail".padStart(5), "warn".padStart(5), "shots".padStart(6), "finds".padStart(6));
  for (const [agent, e] of [...byAgent.entries()].sort()) {
    console.log(agent.padEnd(18), String(e.step).padStart(6), String(e.pass).padStart(5), String(e.fail).padStart(5), String(e.warn).padStart(5), String(e.shot).padStart(6), String(e.findings).padStart(6));
  }

  console.log(`\n${"═".repeat(72)}\nFINDINGS (${findings.length})\n${"═".repeat(72)}`);
  for (const f of findings) console.log(`[${f.severity.toUpperCase().padEnd(8)}] ${f.agent.padEnd(15)} ${(f.role ?? "-").padEnd(12)} ${f.title.slice(0, 90)}`);

  console.log(`\n${"═".repeat(72)}\nLOGIN / SESSION EVENTS\n${"═".repeat(72)}`);
  for (const e of events.filter((e) => e.agent === "login" || (e.agent === "orchestrator" && /Role:|session|fallback/i.test(e.message)))) {
    console.log(`  ${e.level.padEnd(5)} ${e.message.slice(0, 110)}`);
  }

  console.log(`\nRun ${runId} complete. DB: data/webtester.db\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
