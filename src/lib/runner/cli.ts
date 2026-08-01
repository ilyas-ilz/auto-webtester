import { loadEnvLocal } from "./env";
loadEnvLocal(); // tsx doesn't load .env.local — without this, CLI runs always had the AI layer off
import { nanoid } from "nanoid";
import type { Project, RoleCred, RunMode } from "../types";
import { createProject, listFindings } from "../db";
import { runProject } from "./orchestrate";
import { recordFeedbackForFinding, type FeedbackVerdict } from "./feedback";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const FEEDBACK_VERDICTS: FeedbackVerdict[] = ["confirmed", "false_positive", "intended"];

/** Plan-v8 §3.3 — the laziest feedback entry point: mark a finding once, it's
 * suppressed (with this reason, never deleted) in every future report for the site. */
function feedbackCommand(): void {
  const [runId, findingIdStr, verdict, reason] = process.argv.slice(3);
  if (!runId || !findingIdStr || !FEEDBACK_VERDICTS.includes(verdict as FeedbackVerdict)) {
    console.error(`Usage:\n  npm run agents -- feedback <runId> <findingId> confirmed|false_positive|intended ["reason"]`);
    process.exit(1);
  }
  const result = recordFeedbackForFinding(runId, Number(findingIdStr), verdict as FeedbackVerdict, reason ?? "");
  if (!result.ok) { console.error(result.error); process.exit(1); }
  console.log(`Recorded: finding #${findingIdStr} ("${result.findingTitle}") marked ${verdict} for ${result.origin}.`);
  console.log(verdict === "confirmed" ? "It will be tagged as human-confirmed in every future report." : "It will be suppressed (with this reason, never deleted) in every future report until changed.");
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv[2] === "feedback") { feedbackCommand(); return; }
  const demo = process.argv.includes("--demo");
  let project: Project;

  if (demo) {
    // SauceDemo is a public app built for test automation (login: standard_user / secret_sauce).
    const role: RoleCred = { id: nanoid(), name: "Standard User", username: "standard_user", password: "secret_sauce" };
    project = { id: nanoid(), name: "SauceDemo", baseUrl: "https://www.saucedemo.com", envTag: "production", loginPath: "/", registerPath: "", testInboxUrl: "", sessionState: "", notes: "demo", requirements: "", uploadFilePath: "", repoPath: "", roles: [role], journeys: [], createdAt: new Date().toISOString() };
  } else {
    const baseUrl = arg("url");
    if (!baseUrl) {
      console.error("Usage:\n  npm run agents -- --url <baseUrl> --login </login> --user <u> --pass <p> [--role Name] [--env production|staging|localhost] [--mode quick|smart|full]\n  npm run agents -- --demo");
      process.exit(1);
    }
    const role: RoleCred = { id: nanoid(), name: arg("role", "User")!, username: arg("user", "")!, password: arg("pass", "")! };
    project = { id: nanoid(), name: arg("name", "Target")!, baseUrl, envTag: arg("env", "production") as Project["envTag"], loginPath: arg("login", "/login")!, registerPath: arg("register", "")!, testInboxUrl: arg("inbox", "")!, sessionState: arg("session-state", "")!, notes: "", requirements: "", uploadFilePath: arg("upload", "")!, repoPath: arg("repo", "")!, roles: role.username ? [role] : [], journeys: [], createdAt: new Date().toISOString() };
  }

  createProject(project);
  const mode = (arg("mode", "quick") as RunMode);
  console.log(`\n▶ Running local agents against ${project.baseUrl} (${mode} mode)...\n`);
  const runId = await runProject(project, mode);

  const findings = listFindings(runId);
  const bar = "─".repeat(8);
  console.log(`\n${bar} FINDINGS (${findings.length}) ${bar}`);
  for (const f of findings) {
    console.log(`[${f.severity.toUpperCase().padEnd(8)}] ${f.agent.padEnd(13)} ${f.title}${f.pageUrl ? `  (${f.pageUrl})` : ""}`);
  }
  console.log(`\nRun ${runId} complete. Full event log + findings are in data/webtester.db\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
