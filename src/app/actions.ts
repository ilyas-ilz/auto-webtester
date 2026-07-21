"use server";

import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createProject as dbCreateProject, deleteProject as dbDeleteProject, getProject } from "@/lib/db";
import { startRun } from "@/lib/runner/orchestrate";
import type { Project, RunMode } from "@/lib/types";

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
  baseUrl: z.string().refine((v) => { try { new URL(v); return true; } catch { return false; } }, "Enter a full URL, e.g. https://app.example.com"),
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
  redirect(`/projects/${project.id}`);
}

export async function deleteProjectAction(id: string): Promise<void> {
  dbDeleteProject(id);
  redirect("/");
}

export async function startRunAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const mode = (String(formData.get("mode") ?? "quick") as RunMode);
  const project = getProject(projectId);
  if (!project) return;
  const runId = startRun(project, mode);
  redirect(`/projects/${projectId}/runs/${runId}`);
}
