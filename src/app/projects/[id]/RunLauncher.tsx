"use client";

import { useFormStatus } from "react-dom";
import { startRunAction } from "@/app/actions";
import type { RunMode } from "@/lib/types";

const MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "quick", label: "Quick", hint: "Deterministic only · 2-5 min" },
  { value: "smart", label: "Smart", hint: "+ AI review · 10-20 min" },
  { value: "full", label: "Full Audit", hint: "Everything, deep sampling" },
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_16px_rgba(99,102,241,0.35)] transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
    >
      {pending ? "Starting…" : "Start run"}
    </button>
  );
}

export function RunLauncher({ projectId, aiAvailable }: { projectId: string; aiAvailable: boolean }) {
  return (
    <form action={startRunAction} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {MODES.map((m, i) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-panel-2 p-3 text-sm transition-colors has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/10">
            <input type="radio" name="mode" value={m.value} defaultChecked={i === 0} className="mt-0.5 accent-indigo-500" />
            <span>
              <span className="block font-medium">{m.label}</span>
              <span className="block text-xs text-muted">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {!aiAvailable && <p className="text-xs text-muted">Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (cheap models) in .env.local to enable the AI layer in Smart/Full Audit — deterministic checks still run without it.</p>}
      <SubmitButton />
    </form>
  );
}
