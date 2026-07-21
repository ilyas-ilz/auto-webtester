import Link from "next/link";
import { listProjectsSafe, listRuns } from "@/lib/db";
import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { timeAgo } from "@/lib/format";

const ENV_STYLES: Record<string, string> = {
  localhost: "border-zinc-600/40 bg-zinc-500/10 text-zinc-300",
  staging: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  production: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

export default function Home() {
  const projects = listProjectsSafe();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <p className="section-label">Dashboard</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Projects</h1>
        <p className="mt-1 text-sm text-muted">Point an agent fleet at your app — login, explore, test, report.</p>
      </div>

      {projects.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10">
            <span className="text-2xl">🧪</span>
          </div>
          <p className="font-medium">No projects yet</p>
          <p className="max-w-sm text-sm text-muted">Add a target URL and role credentials to run your first Quick Test.</p>
          <Link href="/projects/new" className="mt-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-[0_0_16px_rgba(99,102,241,0.35)] hover:bg-indigo-500">
            Create a project
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const lastRun = listRuns(p.id)[0];
            return (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="flex h-full flex-col gap-3 p-5 transition-colors hover:border-indigo-500/40 hover:bg-panel-2">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium">{p.name}</h2>
                    <span className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${ENV_STYLES[p.envTag]}`}>{p.envTag}</span>
                  </div>
                  <p className="truncate font-mono text-xs text-muted">{p.baseUrl}</p>
                  <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
                    <span>{p.roles.length} role{p.roles.length === 1 ? "" : "s"}</span>
                    {lastRun ? (
                      <span className="flex items-center gap-1.5">
                        <StatusBadge status={lastRun.status} />
                        {timeAgo(lastRun.startedAt)}
                      </span>
                    ) : (
                      <span>No runs yet</span>
                    )}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
