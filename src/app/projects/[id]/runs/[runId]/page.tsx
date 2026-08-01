import { notFound } from "next/navigation";
import { getRun, listLiveEvents, listEventsPage, listFindingsPage, countFindings, findingAgents, getProjectSafe } from "@/lib/db";
import { LiveRun } from "./LiveRun";

export const PAGE_SIZE = 25;
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, runId } = await params;
  const sp = await searchParams;
  const project = getProjectSafe(id);
  const run = getRun(runId);
  if (!project || !run || run.projectId !== id) notFound();

  // Filters live in the URL so the page you land on is the page you can link to,
  // and so SQL — not the browser — decides which 25 rows get rendered.
  const sev = (one(sp.sev) ?? "").split(",").filter((s) => SEVERITIES.includes(s));
  const kind = one(sp.kind) === "bug" || one(sp.kind) === "improvement" ? one(sp.kind) : undefined;
  const agent = one(sp.agent) || undefined;
  const fp = Math.max(1, Number(one(sp.fp)) || 1);
  const tp = Math.max(1, Number(one(sp.tp)) || 1);

  const findings = listFindingsPage(runId, { severities: sev, kind, agent }, PAGE_SIZE, (fp - 1) * PAGE_SIZE);
  const timeline = listEventsPage(runId, PAGE_SIZE * 2, (tp - 1) * PAGE_SIZE * 2);

  // Handed to the client so the live view can authenticate its own control calls.
  // Same exposure as the page itself: set the token when the app sits behind an
  // auth proxy, and the token is only ever in HTML that proxy already gates.
  return (
    <LiveRun
      projectId={id}
      projectName={project.name}
      initialRun={run}
      liveEvents={listLiveEvents(runId)}
      findings={findings}
      timeline={timeline}
      findingsTotal={countFindings(runId)}
      agents={findingAgents(runId)}
      query={{ sev, kind, agent, fp, tp }}
      pageSize={PAGE_SIZE}
      controlToken={process.env.WEBTESTER_CONTROL_TOKEN ?? ""}
    />
  );
}
