import type { RunStatus } from "@/lib/types";

// UI-6 (WEBTESTER-AUDIT): every status needs its own look. `failed`/`error` used to be
// the same red and `inconclusive`/`cancelled` the same amber, which hid the distinction
// that matters most: "your app has a bug" vs "the tester broke" vs "we don't know".
const STYLES: Record<RunStatus, string> = {
  queued: "border-zinc-600/40 bg-zinc-500/10 text-zinc-300",
  running: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  passed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/50 bg-red-500/15 text-red-300",
  error: "border-orange-500/50 bg-orange-500/10 text-orange-300",
  inconclusive: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  cancelled: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
};

// A glyph, so the statuses stay distinguishable without relying on colour alone
// (colour-blind readers, and the badge is tiny).
const GLYPH: Partial<Record<RunStatus, string>> = {
  passed: "✓",
  failed: "✗",
  error: "!",
  inconclusive: "?",
  cancelled: "■",
};

// What each terminal status actually means — the badge text alone doesn't say.
const TITLE: Record<RunStatus, string> = {
  queued: "Waiting to start",
  running: "Agents are working",
  passed: "No unsuppressed critical/high bugs, and every scheduled agent completed",
  failed: "Real critical/high bug finding(s) in the target app",
  error: "The run crashed — this is a tester failure, not necessarily an app defect",
  inconclusive: "Finished, but agents failed — the evidence is incomplete, so neither pass nor fail is honest",
  cancelled: "Stopped by a human before finishing",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      title={TITLE[status]}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${STYLES[status]}`}
    >
      {GLYPH[status] ? (
        <span aria-hidden className="text-[10px] leading-none">{GLYPH[status]}</span>
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "running" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      )}
      {status}
    </span>
  );
}
