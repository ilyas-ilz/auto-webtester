import Link from "next/link";
import { notFound } from "next/navigation";
import { getProjectSafe, listRuns, graphSummary } from "@/lib/db";
import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { timeAgo, duration } from "@/lib/format";
import { RunLauncher } from "./RunLauncher";
import { DeleteProjectButton } from "./DeleteProjectButton";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProjectSafe(id);
  if (!project) notFound();

  const runs = listRuns(id);
  const graph = graphSummary(id);
  const aiAvailable = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="section-label">Project</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{project.name}</h1>
          <a href={project.baseUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-indigo-400 hover:underline">{project.baseUrl}</a>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {project.roles.map((r) => (
              <span key={r.id} className="rounded-md border border-line bg-panel-2 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted">{r.name}</span>
            ))}
          </div>
        </div>
        <DeleteProjectButton projectId={id} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card className="p-5">
            <p className="section-label mb-3">Run a test</p>
            <RunLauncher projectId={id} aiAvailable={aiAvailable} />
          </Card>

          <div>
            <p className="section-label mb-3">Recent runs</p>
            {runs.length === 0 ? (
              <Card className="px-5 py-10 text-center text-sm text-muted">No runs yet — start one above.</Card>
            ) : (
              <div className="flex flex-col gap-2">
                {runs.map((r) => (
                  <Link key={r.id} href={`/projects/${id}/runs/${r.id}`}>
                    <Card className="flex items-center justify-between gap-3 p-4 transition-colors hover:border-indigo-500/40 hover:bg-panel-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium capitalize">{r.mode}</span>
                          <StatusBadge status={r.status} />
                        </div>
                        <p className="mt-1 truncate text-xs text-muted">{r.summary?.split("\n")[0] ?? "Running…"}</p>
                      </div>
                      <div className="shrink-0 text-right font-mono text-xs text-muted">
                        <div>{timeAgo(r.startedAt)}</div>
                        <div>{duration(r.startedAt, r.finishedAt)}{r.aiTokens > 0 ? ` · ${r.aiTokens} tok` : ""}</div>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <p className="section-label mb-3">Knowledge graph</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-line bg-panel-2 p-3 text-center">
                <div className="font-mono text-2xl font-semibold text-indigo-300">{graph.pages}</div>
                <div className="text-xs text-muted">pages mapped</div>
              </div>
              <div className="rounded-lg border border-line bg-panel-2 p-3 text-center">
                <div className="font-mono text-2xl font-semibold text-indigo-300">{graph.apis}</div>
                <div className="text-xs text-muted">APIs mapped</div>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">Builds up across runs — later runs reuse this instead of exploring from scratch.</p>
          </Card>
          {project.notes && (
            <Card className="p-5">
              <p className="section-label mb-2">Focus prompt</p>
              <p className="text-sm text-muted">{project.notes}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
