import type { RunStatus } from "@/lib/types";

const STYLES: Record<RunStatus, string> = {
  queued: "border-zinc-600/40 bg-zinc-500/10 text-zinc-300",
  running: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  passed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/40 bg-red-500/10 text-red-300",
  error: "border-red-500/40 bg-red-500/10 text-red-300",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${STYLES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "running" ? "animate-pulse" : ""}`} />
      {status}
    </span>
  );
}
