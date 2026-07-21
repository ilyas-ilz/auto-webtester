import { notFound } from "next/navigation";
import { getRun, listEvents, listFindings, getProjectSafe } from "@/lib/db";
import { LiveRun } from "./LiveRun";

export default async function RunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const project = getProjectSafe(id);
  const run = getRun(runId);
  if (!project || !run || run.projectId !== id) notFound();

  const events = listEvents(runId, 0);
  const findings = listFindings(runId);

  return <LiveRun projectId={id} projectName={project.name} initialRun={run} initialEvents={events} initialFindings={findings} />;
}
