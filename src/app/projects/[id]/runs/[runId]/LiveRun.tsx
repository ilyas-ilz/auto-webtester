"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { SeverityBadge } from "@/components/SeverityBadge";
import { duration, timeAgo } from "@/lib/format";
import type { Run, RunEvent, Finding, Severity, RunReport } from "@/lib/types";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const LEVEL_DOT: Record<RunEvent["level"], string> = {
  step: "bg-zinc-500", pass: "bg-emerald-500", fail: "bg-red-500", warn: "bg-amber-500", shot: "bg-indigo-400",
  status: "bg-sky-400", "agent-start": "bg-zinc-600", "agent-done": "bg-zinc-600",
};
// Mirrors orchestrate.ts's DIMENSION_BY_AGENT (inverted) — only used to explain
// *why* a coverage-map dimension is untested by pointing at its skip reason.
const AGENTS_BY_DIMENSION: Record<string, string[]> = {
  functional: ["route-health", "interaction", "crud", "journey"],
  forms: ["form-validation"], a11y: ["a11y"], visual: ["visual"], security: ["security"], perf: ["perf"], seo: ["seo"],
};

export function LiveRun({ projectId, projectName, initialRun, initialEvents, initialFindings }: {
  projectId: string; projectName: string; initialRun: Run; initialEvents: RunEvent[]; initialFindings: Finding[];
}) {
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(initialEvents);
  const [findings, setFindings] = useState(initialFindings);
  const [view, setView] = useState<"findings" | "timeline">("findings");
  const [severities, setSeverities] = useState<Set<Severity>>(new Set(SEVERITY_ORDER));
  const [kind, setKind] = useState<"all" | "bug" | "improvement">("all");
  const [agent, setAgent] = useState("all");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run.status !== "running") return;
    let lastEventId = events.length ? events[events.length - 1].id : 0;
    const interval = setInterval(async () => {
      try {
        const [runRes, eventsRes, findingsRes] = await Promise.all([
          fetch(`/api/runs/${run.id}`).then((r) => r.json()),
          fetch(`/api/runs/${run.id}/events?after=${lastEventId}`).then((r) => r.json()),
          fetch(`/api/runs/${run.id}/findings`).then((r) => r.json()),
        ]);
        setRun(runRes);
        if (eventsRes.length) {
          lastEventId = eventsRes[eventsRes.length - 1].id;
          setEvents((prev) => [...prev, ...eventsRes]);
        }
        setFindings(findingsRes);
      } catch {
        // transient network hiccup — next tick retries
      }
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastEventId is a closure var, not state; re-running on run.status change is intentional
  }, [run.status, run.id]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el || view !== "timeline") return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [events, view]);

  const report = useMemo<RunReport | null>(() => {
    if (!run.reportJson) return null;
    try { return JSON.parse(run.reportJson) as RunReport; } catch { return null; }
  }, [run.reportJson]);

  // Live view (V2): the shot event stream already carries every screenshot any
  // agent takes; render the latest one as the current frame. Role tags on the
  // event let a multi-role run show session tabs instead of one merged stream.
  const shots = useMemo(() => {
    const list: { src: string; role: string | null; ts: string }[] = [];
    for (const e of events) {
      if (e.level !== "shot" || !e.data) continue;
      try {
        const d = JSON.parse(e.data) as { src?: string; role?: string | null };
        if (d.src) list.push({ src: d.src, role: d.role ?? null, ts: e.ts });
      } catch {
        // malformed event payload — skip this frame
      }
    }
    return list;
  }, [events]);
  const shotRoles = useMemo(() => Array.from(new Set(shots.map((s) => s.role).filter((r): r is string => !!r))), [shots]);
  const [pinnedRole, setPinnedRole] = useState<string | null>(null); // null = auto-follow the latest frame regardless of role
  const latestShot = useMemo(() => {
    const pool = pinnedRole ? shots.filter((s) => s.role === pinnedRole) : shots;
    return pool.length ? pool[pool.length - 1] : null;
  }, [shots, pinnedRole]);

  // Live view (V8): poll the runner's CDP screencast frame (~4fps). Each frame is
  // preloaded off-DOM and only swapped in once decoded, so the <img> never blanks
  // between frames — this is what makes it read as video instead of a slideshow.
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  useEffect(() => {
    if (run.status !== "running" || pinnedRole) { setLiveFrame(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const img = new Image();
      img.onload = () => { if (!alive) return; setLiveFrame(img.src); timer = setTimeout(tick, 250); };
      img.onerror = () => { if (alive) timer = setTimeout(tick, 2000); }; // no frame yet (run warming up / non-chromium)
      img.src = `/shots/${run.id}/live.jpg?t=${Date.now()}`;
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [run.status, run.id, pinnedRole]);

  // Narration + agent timeline (V3): "status" events answer what an agent is doing
  // right now; agent-start/agent-done (emitted once, in withRecovery) drive the
  // queued/running/done state of every agent the Mission Planner scheduled.
  const latestStatus = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].level === "status") return events[i];
    return null;
  }, [events]);

  const timelineRows = useMemo(() => {
    const skipReason = new Map((report?.agentsSkipped ?? []).map((s) => [s.name, s.reason]));
    const started = new Set<string>();
    const done = new Map<string, { durationMs: number; findings: number; failed: boolean }>();
    for (const e of events) {
      if (e.level === "agent-start") started.add(e.agent);
      if (e.level === "agent-done" && e.data) {
        try { done.set(e.agent, JSON.parse(e.data) as { durationMs: number; findings: number; failed: boolean }); } catch { /* malformed payload */ }
      }
    }
    return run.missionAgents.map((name) => {
      const d = done.get(name);
      if (d) return { name, state: d.failed ? ("failed" as const) : ("done" as const), durationMs: d.durationMs, findings: d.findings };
      if (started.has(name)) return { name, state: "running" as const };
      if (run.status !== "running" && skipReason.has(name)) return { name, state: "skipped" as const, reason: skipReason.get(name) };
      return { name, state: "queued" as const };
    });
  }, [run.missionAgents, run.status, events, report]);

  const TIMELINE_STYLE: Record<string, string> = {
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    failed: "border-red-500/40 bg-red-500/10 text-red-300",
    running: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300 animate-pulse",
    skipped: "border-line bg-panel-2 text-muted/50",
    queued: "border-line bg-panel-2 text-muted",
  };
  const TIMELINE_DOT: Record<string, string> = { done: "✓", failed: "✗", running: "●", skipped: "⊘", queued: "○" };

  // Coverage map (V4): for each under-tested template, explain WHY by tracing its
  // missing dimensions back to the agent(s) that would have covered them and
  // reusing that agent's skip reason — the same "why" already surfaced in the
  // Ran/Skipped line above, just attached to the specific route that's missing it.
  const notTestedList = useMemo(() => {
    const matrix = report?.coverageMatrix;
    if (!matrix) return [];
    const skipReason = new Map((report?.agentsSkipped ?? []).map((s) => [s.name, s.reason]));
    return matrix.rows
      .filter((r) => r.notTestedBy.length > 0)
      .slice(0, 15)
      .map((r) => {
        const reasons = new Set<string>();
        for (const dim of r.notTestedBy) {
          const hit = (AGENTS_BY_DIMENSION[dim] ?? []).map((a) => skipReason.get(a)).find(Boolean);
          reasons.add(hit ?? "not sampled within this run's page budget");
        }
        return { template: r.template, dims: r.notTestedBy, reason: [...reasons].join("; ") };
      });
  }, [report]);

  // Code-aware root cause (V7): hints are keyed by finding fingerprint in the report.
  const hintByFingerprint = useMemo(
    () => new Map((report?.rootCauseHints ?? []).map((h) => [h.findingFingerprint, h])),
    [report]
  );

  const agents = useMemo(() => Array.from(new Set(findings.map((f) => f.agent))).sort(), [findings]);
  const filtered = useMemo(
    () => findings.filter((f) => severities.has(f.severity) && (kind === "all" || f.kind === kind) && (agent === "all" || f.agent === agent)),
    [findings, severities, kind, agent]
  );

  function toggleSeverity(s: Severity) {
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next.size ? next : new Set(SEVERITY_ORDER);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href={`/projects/${projectId}`} className="font-mono text-xs text-indigo-400 hover:underline">← {projectName}</Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-xl font-semibold capitalize">{run.mode} run</h1>
            <StatusBadge status={run.status} />
          </div>
        </div>
        <div className="font-mono text-xs text-muted">
          Started {timeAgo(run.startedAt)} · {duration(run.startedAt, run.finishedAt)}{run.aiTokens > 0 ? ` · ${run.aiTokens} AI tokens` : ""}
        </div>
      </div>

      {run.summary && <Card className="whitespace-pre-line border-l-2 border-l-indigo-500 p-4 text-sm">{run.summary}</Card>}

      {(shots.length > 0 || liveFrame) && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="section-label">Live view</div>
            {shotRoles.length > 1 && (
              <div className="flex gap-1">
                <button
                  onClick={() => setPinnedRole(null)}
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${!pinnedRole ? "bg-indigo-500/15 text-indigo-300" : "text-muted hover:text-foreground"}`}
                >
                  Auto
                </button>
                {shotRoles.map((r) => (
                  <button
                    key={r}
                    onClick={() => setPinnedRole(r)}
                    className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${pinnedRole === r ? "bg-indigo-500/15 text-indigo-300" : "text-muted hover:text-foreground"}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
          {liveFrame || latestShot ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- runtime screenshot with unknown dimensions, not a static asset */}
              <img src={liveFrame ?? latestShot!.src} alt="" className="mt-2 max-h-[28rem] w-full rounded-lg border border-line bg-panel-2 object-contain object-top" />
              <div className="mt-1.5 font-mono text-[11px] text-muted">
                {liveFrame
                  ? "● live"
                  : <>{latestShot!.role ? `${latestShot!.role} · ` : ""}{new Date(latestShot!.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</>}
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">No frame for this role yet.</p>
          )}
          {latestStatus && (
            <div className="mt-2 border-t border-line/60 pt-2 text-sm">
              <span className="font-mono text-[11px] text-muted">[{latestStatus.agent}]</span> {latestStatus.message}
            </div>
          )}
        </Card>
      )}

      {run.missionAgents.length > 0 && (
        <Card className="p-4">
          <div className="section-label">Agent timeline</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {timelineRows.map((row) => (
              <span
                key={row.name}
                title={
                  row.state === "done" || row.state === "failed"
                    ? `${Math.round((row.durationMs ?? 0) / 1000)}s · ${row.findings ?? 0} finding(s)`
                    : row.state === "skipped" ? row.reason : undefined
                }
                className={`rounded-md border px-2 py-1 font-mono text-[11px] ${TIMELINE_STYLE[row.state]}`}
              >
                {TIMELINE_DOT[row.state]} {row.name}
              </span>
            ))}
          </div>
        </Card>
      )}

      {report?.seniorReview && (
        <Card className="border-l-2 border-l-violet-500 p-4">
          <div className="section-label">Senior QA sign-off</div>
          <p className="mt-2 text-sm">{report.seniorReview.executive_summary}</p>
          {report.seniorReview.fix_first.length > 0 && (
            <div className="mt-3">
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted">Fix first</div>
              <ol className="mt-1 flex flex-col gap-1.5">
                {report.seniorReview.fix_first.map((x, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{i + 1}. {x.title}</span>
                    <span className="text-muted"> — {x.why_business_impact}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {report.seniorReview.watchlist.length > 0 && (
            <div className="mt-3">
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted">Watchlist</div>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
                {report.seniorReview.watchlist.map((w, i) => <li key={i}>• {w}</li>)}
              </ul>
            </div>
          )}
        </Card>
      )}

      {report && (
        <Card className="p-4">
          <div className="section-label">Coverage report</div>
          <div className="mt-3 flex flex-col gap-1.5">
            {report.sessions.map((s) => {
              const cov = report.coverage.find((c) => c.role === s.role);
              return (
                <div key={s.role} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 pb-1.5 text-sm last:border-0 last:pb-0">
                  <span className={`font-mono text-xs ${s.ok ? "text-emerald-400" : "text-red-400"}`}>{s.ok ? "✓" : "✗"}</span>
                  <span className="font-medium">{s.role}</span>
                  <span className="min-w-0 flex-1 break-words text-xs text-muted">{s.detail}</span>
                  {cov && <span className="shrink-0 font-mono text-[11px] text-muted/70">{cov.pagesTested} pages · {cov.findings} findings</span>}
                </div>
              );
            })}
          </div>
          {report.coverageTotals && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
              <span>Pages {report.coverageTotals.pagesTested}/{report.coverageTotals.pagesDiscovered}</span>
              <span>Templates {report.coverageTotals.templatesTested}/{report.coverageTotals.templatesDiscovered}</span>
              <span>Controls {report.coverageTotals.controlsClicked}/{report.coverageTotals.controlsSeen}</span>
              {(report.coverageTotals.journeysDefined ?? 0) > 0 && (
                <span>Journeys {report.coverageTotals.journeysPassed}/{report.coverageTotals.journeysDefined}</span>
              )}
            </div>
          )}
          {report.patterns && (report.patterns.recurrent.length > 0 || report.patterns.reappeared.length > 0) && (
            <div className="mt-3 border-t border-line/60 pt-3 text-xs">
              {report.patterns.reappeared.length > 0 && (
                <p className="text-amber-400">⟲ {report.patterns.reappeared.length} issue(s) came back after being fixed</p>
              )}
              {report.patterns.recurrent.slice(0, 5).map((r) => (
                <p key={r.title} className="mt-0.5 text-muted">
                  <span className="font-mono text-[11px] text-amber-400/70">{r.runsSeen}/{r.totalRuns}</span> {r.title}
                </p>
              ))}
            </div>
          )}
          {report.regressionFocus && (
            <p className="mt-3 border-t border-line/60 pt-3 text-xs text-muted">
              <span className="font-mono text-sky-400">Δ</span> Prioritized because changed since last run ({report.regressionFocus.changedFiles} file(s),{" "}
              <span className="font-mono text-[11px]">{report.regressionFocus.previousSha.slice(0, 7)}…{report.regressionFocus.commitSha.slice(0, 7)}</span>):{" "}
              <span className="font-mono text-[11px] text-foreground">{report.regressionFocus.paths.slice(0, 6).join(", ")}{report.regressionFocus.paths.length > 6 ? ` +${report.regressionFocus.paths.length - 6} more` : ""}</span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span>Ran: {report.agentsRan.join(", ") || "—"}</span>
            {report.agentsSkipped.length > 0 && (
              <span className="text-amber-400/80">Skipped: {report.agentsSkipped.map((a) => `${a.name} (${a.reason})`).join(", ")}</span>
            )}
          </div>
          {report.traces && report.traces.length > 0 && (
            <div className="mt-3 border-t border-line/60 pt-3">
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted">
                Traces ({report.traces.length}) — open with <code>npx playwright show-trace &lt;file&gt;</code> or drop the zip at{" "}
                <a href="https://trace.playwright.dev" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">trace.playwright.dev</a>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {report.traces.map((t) => (
                  <a key={t.path} href={t.path} download className="rounded-md border border-line bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-muted hover:text-foreground">
                    {t.label}
                  </a>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {report?.lighthouse && report.lighthouse.length > 0 && (
        <Card className="p-4">
          <div className="section-label">Lighthouse</div>
          <div className="mt-3 flex flex-col gap-3">
            {report.lighthouse.map((l) => (
              <div key={l.url} className="border-b border-line/60 pb-3 last:border-0 last:pb-0">
                <div className="truncate font-mono text-[11px] text-muted" title={l.url}>{l.url}</div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>Performance <b className={l.scores.performance < 50 ? "text-red-400" : l.scores.performance < 90 ? "text-amber-400" : "text-emerald-400"}>{l.scores.performance}</b></span>
                  <span>Accessibility <b>{l.scores.accessibility}</b></span>
                  <span>Best Practices <b>{l.scores.bestPractices}</b></span>
                  <span>SEO <b>{l.scores.seo}</b></span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
                  <span>LCP {l.lcpMs !== null ? `${(l.lcpMs / 1000).toFixed(1)}s` : "n/a"}</span>
                  <span>CLS {l.cls !== null ? l.cls.toFixed(2) : "n/a"}</span>
                  <span>TBT {l.tbtMs !== null ? `${Math.round(l.tbtMs)}ms` : "n/a"}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report?.coverageMatrix && report.coverageMatrix.rows.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="section-label">Coverage map</div>
            <span className="font-mono text-[11px] text-muted">
              {report.coverageMatrix.templatesFullyCovered}/{report.coverageMatrix.templatesTotal} template(s) fully covered
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-line/60 text-muted">
                  <th className="py-1 pr-3 font-mono font-normal">Template</th>
                  {report.coverageMatrix.dimensions.map((d) => (
                    <th key={d} className="px-2 py-1 text-center font-mono font-normal capitalize">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.coverageMatrix.rows.slice(0, 25).map((row) => (
                  <tr key={row.template} className="border-b border-line/40 last:border-0">
                    <td className="max-w-xs truncate py-1 pr-3 font-mono text-[11px]" title={row.template}>{row.template}</td>
                    {report.coverageMatrix!.dimensions.map((d) => (
                      <td key={d} className={`px-2 py-1 text-center ${row.tested[d] ? "text-emerald-400" : "text-muted/40"}`}>
                        {row.tested[d] ? "✓" : "·"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {report.coverageMatrix.rows.length > 25 && (
              <p className="mt-1.5 font-mono text-[11px] text-muted">…and {report.coverageMatrix.rows.length - 25} more template(s) (sorted worst-covered first).</p>
            )}
          </div>
          {notTestedList.length > 0 && (
            <div className="mt-3 border-t border-line/60 pt-3">
              <div className="font-mono text-[11px] uppercase tracking-wide text-amber-400/80">Not tested</div>
              <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted">
                {notTestedList.map((n) => (
                  <li key={n.template}>
                    <span className="font-mono text-[11px] text-foreground">{n.template}</span> — {n.dims.join(", ")}{" "}
                    <span className="text-muted/60">({n.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="flex gap-1 rounded-lg border border-line bg-panel p-1 text-sm sm:w-fit">
        {(["findings", "timeline"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-4 py-1.5 font-medium capitalize transition-colors ${view === v ? "bg-indigo-500/15 text-indigo-300" : "text-muted hover:text-foreground"}`}
          >
            {v} {v === "findings" ? `(${findings.length})` : `(${events.length})`}
          </button>
        ))}
      </div>

      {view === "findings" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {SEVERITY_ORDER.map((s) => (
              <button
                key={s}
                onClick={() => toggleSeverity(s)}
                className={`transition-opacity ${severities.has(s) ? "opacity-100" : "opacity-30"}`}
              >
                <SeverityBadge severity={s} />
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-line" />
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded-md border border-line bg-panel px-3 py-1 text-xs">
              <option value="all">All kinds</option>
              <option value="bug">Bugs</option>
              <option value="improvement">Improvements</option>
            </select>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} className="rounded-md border border-line bg-panel px-3 py-1 text-xs">
              <option value="all">All agents</option>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {filtered.length === 0 ? (
            <Card className="px-5 py-12 text-center text-sm text-muted">
              {findings.length === 0 ? "No findings yet — the agents are still working." : "No findings match these filters."}
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {filtered.map((f) => (
                <Card key={f.id} className="flex gap-4 p-4">
                  {f.evidence && (
                    <button onClick={() => setLightbox(f.evidence)} className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element -- runtime screenshot with unknown dimensions, not a static asset */}
                      <img src={f.evidence} alt="" className="h-16 w-16 rounded-lg border border-line object-cover object-top" />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="rounded-md border border-line bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-muted">{f.agent}</span>
                      {f.source === "ai" && <span className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[11px] text-violet-300">AI</span>}
                      {f.source === "zap" && <span className="rounded-md border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 font-mono text-[11px] text-orange-300">ZAP</span>}
                      {f.kind === "improvement" && <span className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-mono text-[11px] text-sky-300">suggestion</span>}
                    </div>
                    <p className="mt-1.5 break-words font-medium">{f.title}</p>
                    <p className="mt-0.5 whitespace-pre-line break-words text-sm text-muted">{f.detail}</p>
                    {(() => {
                      const hint = hintByFingerprint.get(f.fingerprint);
                      if (!hint) return null;
                      return (
                        <div className="mt-2 rounded-lg border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs">
                          <div className="font-mono text-[11px] uppercase tracking-wide text-teal-300">
                            Probable root cause · {Math.round(hint.confidence * 100)}% confident
                          </div>
                          <div className="mt-1 break-all font-mono text-[11px] text-foreground">{hint.file}{hint.line ? `:${hint.line}` : ""}</div>
                          <p className="mt-1 break-words text-muted">{hint.cause}</p>
                          {hint.suggestedFix && <p className="mt-1 break-words"><span className="font-medium text-teal-300">Fix:</span> {hint.suggestedFix}</p>}
                        </div>
                      );
                    })()}
                    <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted/70">
                      {f.role && <span>Role: {f.role}</span>}
                      {f.pageUrl && <span className="break-all">{f.pageUrl}</span>}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Card className="p-0">
          <div ref={timelineRef} className="max-h-[32rem] overflow-y-auto p-4 font-mono text-[13px]">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 border-b border-line/60 py-2 last:border-0">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[e.level]}`} />
                <span className="w-24 shrink-0 truncate text-[11px] text-muted">{e.agent}</span>
                <span className="min-w-0 flex-1 break-words">{e.message}</span>
                <span className="w-14 shrink-0 text-right text-[11px] text-muted">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- runtime screenshot with unknown dimensions, not a static asset */}
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg border border-line shadow-2xl" />
        </div>
      )}
    </div>
  );
}
