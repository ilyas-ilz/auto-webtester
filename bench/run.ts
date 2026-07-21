import http from "http";
import fs from "fs";
import path from "path";
import { createSaasApp } from "./apps/saas";
import { createContentApp } from "./apps/content";
import { createSpaApp } from "./apps/spa";
import { createProject, getProject, listFindings } from "../src/lib/db";
import { runProject } from "../src/lib/runner/orchestrate";
import { scoreBench, formatBenchReport, type SeededDefect, type BenchScore } from "../src/lib/runner/benchScore";
import type { Project, RunMode } from "../src/lib/types";

// Plan-v6 V9: `npm run bench` — runs the fleet against 3 tiny seeded-defect
// apps and prints detection/unseeded/critical-recall/duplicate rates. This is
// the regression harness for every future fleet change: run it before and
// after, compare the numbers. Default mode is quick (deterministic, zero AI
// cost); BENCH_MODE=smart|full widens coverage like any normal run.

interface BenchApp {
  key: string;
  name: string;
  port: number;
  create: () => http.Server;
  project: (baseUrl: string) => Omit<Project, "id" | "createdAt">;
}

const APPS: BenchApp[] = [
  {
    key: "saas", name: "bench: SaaS (multi-role)", port: 4801, create: createSaasApp,
    project: (baseUrl) => ({
      name: "bench: SaaS (multi-role)", baseUrl, envTag: "localhost", loginPath: "/login",
      registerPath: "", testInboxUrl: "", sessionState: "", notes: "seeded-defect benchmark app", requirements: "", uploadFilePath: "", repoPath: "",
      roles: [
        { id: "bench-admin", name: "Admin", username: "admin@bench.local", password: "admin123" },
        { id: "bench-user", name: "User", username: "user@bench.local", password: "user123" },
      ],
      journeys: [],
    }),
  },
  {
    key: "content", name: "bench: content site", port: 4802, create: createContentApp,
    project: (baseUrl) => ({
      name: "bench: content site", baseUrl, envTag: "localhost", loginPath: "/login",
      registerPath: "", testInboxUrl: "", sessionState: "", notes: "seeded-defect benchmark app", requirements: "", uploadFilePath: "", repoPath: "",
      roles: [], journeys: [],
    }),
  },
  {
    key: "spa", name: "bench: button-nav SPA", port: 4803, create: createSpaApp,
    project: (baseUrl) => ({
      name: "bench: button-nav SPA", baseUrl, envTag: "localhost", loginPath: "/login",
      registerPath: "", testInboxUrl: "", sessionState: "", notes: "seeded-defect benchmark app", requirements: "", uploadFilePath: "", repoPath: "",
      roles: [], journeys: [],
    }),
  },
];

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

/** Stable per-app project id so bench runs accumulate history under one project (regression/patterns agents get real prior runs). */
function ensureProject(app: BenchApp): Project {
  const id = `bench-${app.key}`;
  const existing = getProject(id);
  if (existing) return existing;
  const project: Project = { id, createdAt: new Date().toISOString(), ...app.project(`http://127.0.0.1:${app.port}`) };
  createProject(project);
  return project;
}

async function main(): Promise<void> {
  const mode = (process.env.BENCH_MODE as RunMode) || "quick";
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "defects.json"), "utf-8")) as { defects: SeededDefect[] };
  const only = process.argv[2]; // `npm run bench -- saas` runs one app
  const apps = only ? APPS.filter((a) => a.key === only) : APPS;
  if (!apps.length) {
    console.error(`Unknown bench app "${only}". Options: ${APPS.map((a) => a.key).join(", ")}`);
    process.exit(1);
  }

  console.log(`Seeded-defect benchmark — mode=${mode}, apps: ${apps.map((a) => a.key).join(", ")}\n`);
  const scores: { app: string; score: BenchScore }[] = [];

  for (const app of apps) {
    const server = app.create();
    await listen(server, app.port);
    const project = ensureProject(app);
    const defects = manifest.defects.filter((d) => d.app === app.key);
    console.log(`▶ ${app.name} on :${app.port} — ${defects.length} seeded defect(s), running fleet…`);
    const started = Date.now();
    const runId = await runProject(project, mode);
    const findings = listFindings(runId);
    const score = scoreBench(defects, findings);
    scores.push({ app: app.key, score });
    console.log(formatBenchReport(app.key, score));
    console.log(`  run ${runId} (${Math.round((Date.now() - started) / 1000)}s) — inspect at /projects/${project.id}/runs/${runId}\n`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (scores.length > 1) {
    const total = scores.reduce((a, s) => a + s.score.total, 0);
    const detected = scores.reduce((a, s) => a + s.score.detected.length, 0);
    const findings = scores.reduce((a, s) => a + s.score.totalFindings, 0);
    const unseeded = scores.reduce((a, s) => a + s.score.unseededFindings, 0);
    console.log(`── OVERALL ────────────────────────────`);
    console.log(`  detection ${detected}/${total} (${Math.round((detected / Math.max(1, total)) * 100)}%) · ${findings} findings, ${unseeded} unseeded`);
  }
  console.log(`\nClaim honestly: "logic-verified + benchmarked on ${scores.length} seeded app(s)" — production-proven needs real-site mileage.`);
  process.exit(0); // better-sqlite3 handles keep the event loop alive otherwise
}

main().catch((e) => {
  console.error(`bench crashed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
