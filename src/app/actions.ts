"use server";

import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createProject as dbCreateProject, deleteProject as dbDeleteProject, getProject, getRun, requestCancel, deleteRun as dbDeleteRun, hasActiveRun, listRuns } from "@/lib/db";
import { startRun } from "@/lib/runner/orchestrate";
import type { Project } from "@/lib/types";

const roleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Role name is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const journeySchema = z.object({
  name: z.string().min(1, "Journey needs a name"),
  goal: z.string().min(1, "Journey needs a goal"),
  steps: z.array(z.object({ role: z.string().min(1), text: z.string().min(1), expect: z.string().optional() })).min(1, "Journey needs at least one step"),
  maxActions: z.number().int().positive().optional(),
  persona: z.enum(["keyboard-only", "mobile", "slow-network"]).optional(),
});

const projectSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  // P2-1 (WEBTESTER-AUDIT): only http/https — `new URL` alone accepts file:, javascript:, etc.
  baseUrl: z.string().refine((v) => { try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; } }, "Enter a full http(s) URL, e.g. https://app.example.com"),
  envTag: z.enum(["localhost", "staging", "production"]),
  loginPath: z.string().min(1),
  registerPath: z.string(),
  testInboxUrl: z.string(),
  sessionState: z.string().refine((v) => {
    if (!v.trim()) return true;
    try {
      const s = JSON.parse(v) as { cookies?: unknown };
      return typeof s === "object" && s !== null && Array.isArray(s.cookies);
    } catch {
      return false;
    }
  }, 'Session state must be Playwright storageState JSON (an object with a "cookies" array)'),
  notes: z.string(),
  requirements: z.string(),
  uploadFilePath: z.string(),
  repoPath: z.string(),
  // Roles optional: no roles + no session state = anonymous public-surface testing.
  roles: z.array(roleSchema),
  journeys: z.array(journeySchema),
});

export interface FormState {
  error?: string;
}

export async function createProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const names = formData.getAll("role_name") as string[];
  const users = formData.getAll("role_username") as string[];
  const passes = formData.getAll("role_password") as string[];
  const roles = names
    .map((name, i) => ({ id: nanoid(), name: name.trim(), username: (users[i] ?? "").trim(), password: passes[i] ?? "" }))
    .filter((r) => r.name && r.username && r.password);

  let journeys: unknown = [];
  const journeysRaw = ((formData.get("journeys") as string) || "").trim();
  if (journeysRaw) {
    try { journeys = JSON.parse(journeysRaw); } catch { return { error: "Journeys must be valid JSON — an array of { name, goal, steps: [{ role, text }] }." }; }
  }

  const parsed = projectSchema.safeParse({
    name: formData.get("name"),
    baseUrl: formData.get("baseUrl"),
    envTag: formData.get("envTag"),
    loginPath: (formData.get("loginPath") as string) || "/login",
    registerPath: (formData.get("registerPath") as string) || "",
    testInboxUrl: (formData.get("testInboxUrl") as string) || "",
    sessionState: ((formData.get("sessionState") as string) || "").trim(),
    notes: (formData.get("notes") as string) || "",
    requirements: (formData.get("requirements") as string) || "",
    uploadFilePath: ((formData.get("uploadFilePath") as string) || "").trim(),
    repoPath: ((formData.get("repoPath") as string) || "").trim(),
    roles,
    journeys,
  });

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const project: Project = { id: nanoid(), createdAt: new Date().toISOString(), ...parsed.data };
  dbCreateProject(project);
  revalidatePath("/");
  redirect(`/projects/${project.id}`);
}

export async function deleteProjectAction(id: string): Promise<void> {
  // P0-4 (WEBTESTER-AUDIT): never delete a project out from under an executing run —
  // the runner would keep inserting events/findings against vanished rows.
  if (hasActiveRun(id)) redirect(`/projects/${id}?error=active-run`);
  dbDeleteProject(id);
  revalidatePath("/");
  redirect("/");
}

/** Stop button: flags the run; the runner unwinds at its next agent boundary. */
export async function stopRunAction(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  requestCancel(runId);
  revalidatePath(`/projects/${run.projectId}/runs/${runId}`);
}

/** Delete a run and everything it produced. Stops it first if it's still going. */
export async function deleteRunAction(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  if (run.status === "running" || run.status === "queued") {
    // Flag + let the loop unwind, rather than deleting rows an active run still writes to.
    requestCancel(runId);
    for (let i = 0; i < 30 && (getRun(runId)?.status === "running" || getRun(runId)?.status === "queued"); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // P0-4 (WEBTESTER-AUDIT): if it STILL hasn't stopped, refuse to delete — deleting
    // rows an active runner writes to corrupts history. The cancel flag stays set;
    // the user can delete once the run reaches a terminal state.
    const s = getRun(runId)?.status;
    if (s === "running" || s === "queued") redirect(`/projects/${run.projectId}/runs/${runId}?error=still-stopping`);
  }
  dbDeleteRun(runId);
  revalidatePath("/");
  revalidatePath(`/projects/${run.projectId}`);
  redirect(`/projects/${run.projectId}`);
}

/** Retry an interrupted run: same project + mode, resuming where that one stopped. */
export async function retryRunAction(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const project = getProject(run.projectId);
  if (!project) return;
  const active = listRuns(run.projectId).find((r) => r.status === "running" || r.status === "queued");
  if (active) redirect(`/projects/${run.projectId}/runs/${active.id}`);
  const newId = startRun(project, run.mode, runId);
  redirect(`/projects/${run.projectId}/runs/${newId}`);
}

export async function startRunAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  // P2-1 (WEBTESTER-AUDIT): parse, don't cast — an unknown mode falls back to quick.
  const mode = z.enum(["quick", "smart", "full"]).catch("quick").parse(formData.get("mode"));
  const project = getProject(projectId);
  if (!project) return;
  // P1-2: one run per project — jump to the already-active run instead of stacking a second.
  const active = listRuns(projectId).find((r) => r.status === "running" || r.status === "queued");
  if (active) redirect(`/projects/${projectId}/runs/${active.id}`);
  const runId = startRun(project, mode);
  revalidatePath("/");
  redirect(`/projects/${projectId}/runs/${runId}`);
}
