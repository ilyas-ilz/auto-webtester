import type { Severity } from "@/lib/types";

const STYLES: Record<Severity, string> = {
  critical: "border-red-500/40 bg-red-500/10 text-red-300",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  info: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${STYLES[severity]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {severity}
    </span>
  );
}
