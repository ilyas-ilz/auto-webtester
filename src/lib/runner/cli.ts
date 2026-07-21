import { nanoid } from "nanoid";
import type { Project, RoleCred, RunMode } from "../types";
import { createProject, listFindings } from "../db";
import { runProject } from "./orchestrate";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
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
