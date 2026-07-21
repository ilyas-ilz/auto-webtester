// Real-browser end-to-end test of the webtester dashboard ITSELF (the Next.js UI
// at localhost:3000), as opposed to the target sites the tool points its agents at.
//
// Drives the actual UI with a real Playwright chromium: home renders -> create a
// project through the real form + server action -> start a Quick run (0 AI budget,
// so no API cost) -> wait for the run to reach a TERMINAL status (proving the
// lifecycle completes and never sticks on RUNNING) -> assert the run page hydrates
// with findings -> delete the project (exercises the delete flow AND self-cleans,
// so a test run never leaves an orphan project behind).
//
// ponytail: reuses the already-installed `playwright` dep + `tsx`, mirroring
// selftest.ts. No @playwright/test framework, no config, no new dependency.
//
// Run:  npm run ui:e2e            (dev server must be up: npm run dev)
// Env:  E2E_BASE_URL (default http://localhost:3000)
//       E2E_TARGET_URL (default https://example.com — tiny, quick run finishes fast)
//       E2E_RUN_TIMEOUT_MS (default 180000)

import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const TARGET = process.env.E2E_TARGET_URL ?? "https://example.com";
const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS ?? 180_000);
const TERMINAL = new Set(["passed", "failed", "error"]);

const steps: string[] = [];
function ok(msg: string): void {
  steps.push(msg);
  // eslint-disable-next-line no-console -- CLI test harness, mirrors selftest.ts
  console.log(`  ✓ ${msg}`);
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { method: "GET" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!(await reachable())) {
    // eslint-disable-next-line no-console
    console.error(`✗ dev server not reachable at ${BASE}\n  Start it first:  npm run dev   (or set E2E_BASE_URL)`);
    process.exit(2);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let projectId = "";
  const name = `E2E smoke ${Date.now()}`;

  try {
    // 1. Home dashboard renders.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 15_000 });
    ok("home dashboard renders");

    // 2. Create a project through the real form + server action.
    await page.goto(`${BASE}/projects/new`, { waitUntil: "domcontentloaded" });
    await page.fill("#name", name);
    await page.fill("#baseUrl", TARGET);
    await page.selectOption("#envTag", "localhost");
    await page.click('button[type="submit"]');
    // Wait for the project page (its <h1> is the project name — the form has no such heading),
    // then read the id. Don't race waitForURL: /projects/new also matches a naive /projects/:id regex.
    await page.getByRole("heading", { name }).waitFor({ timeout: 15_000 });
    projectId = page.url().split("/projects/")[1];
    assert(projectId && projectId !== "new", `expected a project id in the URL, got "${projectId}"`);
    ok(`project created (${projectId})`);

    // 3. Start a Quick run (Quick is the default-checked mode).
    await Promise.all([
      page.waitForURL(/\/runs\/[^/]+$/, { timeout: 15_000 }),
      page.getByRole("button", { name: "Start run" }).click(),
    ]);
    const runId = page.url().split("/runs/")[1];
    ok(`quick run started (${runId})`);

    // 4. Wait for a TERMINAL status via the same API the live UI polls.
    //    This is the exact behavior that was broken before (runs stuck on RUNNING).
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let status = "queued";
    while (Date.now() < deadline) {
      const run = await page.request.get(`${BASE}/api/runs/${runId}`).then((r) => r.json());
      status = run.status;
      if (TERMINAL.has(status)) break;
      await page.waitForTimeout(2000);
    }
    assert(TERMINAL.has(status), `run never reached a terminal status within ${RUN_TIMEOUT_MS}ms (stuck on "${status}")`);
    ok(`run reached terminal status: ${status}`);

    // 5. Run page hydrates with the completed run — findings surface, and it is
    //    NOT stuck showing a "running" badge (the user's core worry).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /quick run/i }).waitFor({ timeout: 10_000 });
    const findingsTab = (await page.getByRole("button", { name: /^findings \(\d+\)$/i }).textContent())?.trim();
    assert(findingsTab, "findings tab did not render on the completed run page");
    const stillRunning = await page.getByText("running", { exact: true }).count();
    assert(stillRunning === 0, "run page still shows a RUNNING badge after a terminal status");
    ok(`run page hydrated (${findingsTab}, not stuck running)`);

    // 6. Delete the project: exercises the confirm-dialog delete flow AND cleans up.
    await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await Promise.all([
      page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 15_000 }),
      page.getByRole("button", { name: "Delete project", exact: true }).click(),
    ]);
    const stillListed = await page.getByText(name, { exact: true }).count();
    assert(stillListed === 0, "project still appears on the dashboard after delete");
    projectId = "";
    ok("project deleted (cleanup verified — no orphan left behind)");

    // eslint-disable-next-line no-console
    console.log(`\n✓ UI e2e PASSED — ${steps.length} steps, run ended "${status}"`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`\n✗ UI e2e FAILED at step ${steps.length + 1}:`, err instanceof Error ? err.message : err);
    if (projectId) {
      // Best-effort cleanup so a failed test doesn't leave a stray project.
      try {
        await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByRole("button", { name: "Delete project", exact: true }).click();
        await page.waitForTimeout(1500);
      } catch {
        // ignore — nothing more we can do
      }
    }
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

void main();
