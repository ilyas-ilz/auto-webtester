"use client";

import { useActionState, useState } from "react";
import { nanoid } from "nanoid";
import { createProjectAction, type FormState } from "@/app/actions";

const input =
  "w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm placeholder:text-muted/60 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30";
const select = `${input} cursor-pointer appearance-none pr-10`;
const label = "mb-1.5 block text-sm font-medium text-zinc-300";

interface RoleRow { key: string; name: string; username: string; password: string }

const initialState: FormState = {};

export function ProjectForm() {
  const [state, formAction, pending] = useActionState(createProjectAction, initialState);
  const [roles, setRoles] = useState<RoleRow[]>([{ key: nanoid(), name: "Admin", username: "", password: "" }]);

  function updateRole(key: string, field: keyof Omit<RoleRow, "key">, value: string) {
    setRoles((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div>
        <label className={label} htmlFor="name">Project name</label>
        <input className={input} id="name" name="name" placeholder="My SaaS App" required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="baseUrl">Target URL</label>
          <input className={input} id="baseUrl" name="baseUrl" type="url" placeholder="https://app.example.com" required />
        </div>
        <div>
          <label className={label} htmlFor="envTag">Environment</label>
          <div className="relative">
            <select className={select} id="envTag" name="envTag" defaultValue="localhost">
              <option value="localhost">Localhost</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
            <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="loginPath">Login path</label>
        <input className={input} id="loginPath" name="loginPath" defaultValue="/login" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="registerPath">Signup path (optional)</label>
          <input className={input} id="registerPath" name="registerPath" placeholder="/signup — enables self-registration test" />
        </div>
        <div>
          <label className={label} htmlFor="testInboxUrl">Test inbox URL (optional)</label>
          <input className={input} id="testInboxUrl" name="testInboxUrl" placeholder="http://localhost:8025 — Mailpit, for OTP/verify" />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="sessionState">Session state (optional — for OAuth-only sites)</label>
        <textarea
          className={`${input} min-h-20 resize-y font-mono text-xs`}
          id="sessionState"
          name="sessionState"
          placeholder='If login is only "Sign in with Google" etc., log in manually once and paste Playwright storageState JSON here (npx playwright codegen --save-storage=state.json <url>)'
        />
      </div>

      <div>
        <label className={label} htmlFor="notes">Focus prompt (optional)</label>
        <textarea className={`${input} min-h-20 resize-y`} id="notes" name="notes" placeholder='e.g. "focus on billing flows"' />
      </div>

      <div>
        <label className={label} htmlFor="requirements">Acceptance criteria (optional — one per line, smart/full runs)</label>
        <textarea
          className={`${input} min-h-24 resize-y`}
          id="requirements"
          name="requirements"
          placeholder={`AI checks each against what the run observed (met / not met / unverifiable). e.g.
Users can reset their password from the login page
Prices always show two decimal places
An employer cannot edit a job after it is closed`}
        />
      </div>

      <div>
        <label className={label} htmlFor="uploadFilePath">Sample upload file path (optional — non-production, tests file inputs)</label>
        <input className={`${input} font-mono text-xs`} id="uploadFilePath" name="uploadFilePath" placeholder="C:\\path\\to\\sample.pdf — uploaded into any file input to check the upload UI reacts" />
      </div>

      <div>
        <label className={label} htmlFor="repoPath">Source repo path (optional — enables code-aware root cause)</label>
        <input className={`${input} font-mono text-xs`} id="repoPath" name="repoPath" placeholder="D:\\code\\my-app — local checkout; findings get a probable file:line + suggested fix, and changed files get retested first" />
      </div>

      <div>
        <label className={label} htmlFor="journeys">Business journeys (optional — JSON, smart/full runs)</label>
        <textarea
          className={`${input} min-h-24 resize-y font-mono text-xs`}
          id="journeys"
          name="journeys"
          placeholder={`AI drives these flows end-to-end. Cross-role steps test multi-user flows. e.g.
[{"name":"Post & apply","goal":"a job is posted then applied to","steps":[
  {"role":"Employer","text":"Create a job posting titled QA-BOT {tag}"},
  {"role":"Employer","text":"Publish it"},
  {"role":"Jobseeker","text":"Find that job and apply"}]}]`}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={label}>Roles &amp; credentials (optional — leave empty to test public pages only)</span>
          <button
            type="button"
            onClick={() => setRoles((rs) => [...rs, { key: nanoid(), name: "", username: "", password: "" }])}
            className="text-sm font-medium text-indigo-400 hover:text-indigo-300"
          >
            + Add role
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {roles.map((r) => (
            <div key={r.key} className="rounded-lg border border-line bg-background/40 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input className={input} placeholder="Role name (Admin)" value={r.name} onChange={(e) => updateRole(r.key, "name", e.target.value)} name="role_name" />
                <input className={input} placeholder="Username / email" value={r.username} onChange={(e) => updateRole(r.key, "username", e.target.value)} name="role_username" />
                <input className={input} placeholder="Password" type="password" value={r.password} onChange={(e) => updateRole(r.key, "password", e.target.value)} name="role_password" />
              </div>
              {roles.length > 1 && (
                <button type="button" onClick={() => setRoles((rs) => rs.filter((x) => x.key !== r.key))} className="mt-2 text-xs font-medium text-red-400 hover:text-red-300">
                  Remove role
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {state?.error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300" aria-live="polite">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_16px_rgba(99,102,241,0.35)] transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
