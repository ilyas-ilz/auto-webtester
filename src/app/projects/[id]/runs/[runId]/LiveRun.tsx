"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { SeverityBadge } from "@/components/SeverityBadge";
import { duration, timeAgo } from "@/lib/format";
import { plainImpact } from "@/lib/plain";
import { deriveAgentView } from "@/lib/report-view";
import type { Run, RunEvent, RunQuestion, Finding, Severity, RunReport } from "@/lib/types";
import { stopRunAction, deleteRunAction, retryRunAction } from "@/app/actions";

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

type Page<T> = { rows: T[]; total: number };

const RUN_STATUSES = new Set(["queued", "running", "passed", "failed", "inconclusive", "error", "cancelled"]);

// Left accent for the "why this verdict" card, matched to the badge colours (UI-1/UI-6).
const VERDICT_ACCENT: Partial<Record<string, string>> = {
  passed: "border-l-emerald-500",
  failed: "border-l-red-500",
  error: "border-l-orange-500",
  inconclusive: "border-l-amber-500",
  cancelled: "border-l-zinc-500",
};

/**
 * UI-2 (WEBTESTER-AUDIT): is this JSON really the run we asked for? The API answers
 * `{ error: … }` on 404/403 with the same shape as any other JSON, so the poll needs
 * a positive identification before it replaces live run state.
 */
function isRunPayload(v: unknown, expectedId: string): v is Run {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<Run>;
  return r.id === expectedId && typeof r.status === "string" && RUN_STATUSES.has(r.status);
}

// ponytail: prev/next + "page N of M", no numbered window. Add numbers when a
// run routinely spans enough pages that stepping through them gets tedious.
function Pager({ page, pages, onGo }: { page: number; pages: number; onGo: (p: number) => void }) {
  if (pages <= 1) return null;
  const btn = "rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-30";
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <button className={btn} onClick={() => onGo(page - 1)} disabled={page <= 1}>← prev</button>
      <span className="font-mono text-[11px] text-muted">{Math.min(page, pages)} / {pages}</span>
      <button className={btn} onClick={() => onGo(page + 1)} disabled={page >= pages}>next →</button>
    </div>
  );
}

export function LiveRun({
  projectId, projectName, initialRun, liveEvents, findings, timeline, findingsTotal, agents, query, pageSize, controlToken,
}: {
  projectId: string; projectName: string; initialRun: Run;
  liveEvents: RunEvent[];
  findings: Page<Finding>;
  timeline: Page<RunEvent>;
  findingsTotal: number;
  agents: string[];
  query: { sev: string[]; kind?: string; agent?: string; fp: number; tp: number };
  pageSize: number;
  controlToken: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Every list control writes to the URL; the server re-renders the page from it.
  // Soft navigation keeps this component mounted, so the live view never blinks.
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const severities = useMemo(
    () => new Set<Severity>(query.sev.length ? (query.sev as Severity[]) : SEVERITY_ORDER),
    [query.sev]
  );
  const kind = (query.kind ?? "all") as "all" | "bug" | "improvement";
  const agent = query.agent ?? "all";

  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(liveEvents);
  const [view, setView] = useState<"findings" | "timeline">("findings");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // 0 until mounted — keeps clock-relative text out of the SSR HTML
  const [questions, setQuestions] = useState<RunQuestion[]>([]);
  const [answer, setAnswer] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [urlBar, setUrlBar] = useState("");
  const [pollError, setPollError] = useState<string | null>(null); // UI-2/UI-4: connection or control failures, shown instead of swallowed
  const [zoom, setZoom] = useState<"fit" | 100 | 125 | 150 | 200>("fit"); // viewer-only zoom — CSS scale of the streamed image, never the page itself, so it can't shift layouts and contaminate findings
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLImageElement>(null);
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastMove = useRef(0);

  // Position relative to the wrapper's scrolled content, not the viewport — matters once zoom makes the frame scroll.
  function spawnRipple(clientX: number, clientY: number) {
    const wrap = frameWrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const id = Date.now() + Math.random();
    const x = clientX - box.left + wrap.scrollLeft;
    const y = clientY - box.top + wrap.scrollTop;
    setRipples((r) => [...r, { id, x, y }]);
    setTimeout(() => setRipples((r) => r.filter((it) => it.id !== id)), 500);
  }

  useEffect(() => {
    const first = setTimeout(() => setTick(1), 0); // paint the clock text right after hydration, not during it
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);

  useEffect(() => {
    if (run.status !== "running") return;
    let lastEventId = events.length ? events[events.length - 1].id : 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    // Self-scheduling poll, not setInterval: a slow tick used to overlap the next one,
    // both asked for ?after=<same id>, and the same events got appended twice —
    // React then saw duplicate keys. One request in flight at a time fixes it at the root.
    const tick = async () => {
      try {
        const [runRes, eventsRes, questionsRes] = await Promise.all([
          fetch(`/api/runs/${run.id}`).then((r) => r.json()),
          fetch(`/api/runs/${run.id}/events?after=${lastEventId}`).then((r) => r.json()),
          fetch(`/api/runs/${run.id}/questions`).then((r) => r.json()),
        ]);
        if (!alive) return;
        // UI-2 (WEBTESTER-AUDIT): the run API answers `{ error: "not found" }` with a
        // 404, and a guarded deployment answers `{ error: "forbidden" }` — assigning
        // either into run state replaced a real run with an object having no id,
        // status, or missionAgents, blanking the page. Only a payload that is
        // recognisably THIS run is allowed to replace it.
        if (isRunPayload(runRes, run.id)) {
          setRun(runRes);
          setPollError(null);
        } else {
          setPollError("Lost contact with this run (the server did not return it). Showing the last known state.");
        }
        // P1-15: a protected deployment returns { error } here too — storing that
        // object used to crash the component on `.find()` later.
        if (Array.isArray(questionsRes)) setQuestions(questionsRes);
        const fresh = Array.isArray(eventsRes) ? (eventsRes as RunEvent[]).filter((e) => e.id > lastEventId) : []; // belt-and-braces vs a stale/forbidden response
        if (fresh.length) {
          lastEventId = fresh[fresh.length - 1].id;
          setEvents((prev) => [...prev, ...fresh]);
          // Findings and the event log are server-paginated — refresh the RSC
          // payload instead of refetching the whole list into the client.
          router.refresh();
        }
        // P1-19: a run can reach a terminal state without one final event —
        // refresh once on the transition so findings committed at finalization
        // appear without a manual reload.
        if (isRunPayload(runRes, run.id) && runRes.status !== "running" && runRes.status !== "queued") router.refresh();
      } catch {
        if (alive) setPollError("Connection to the server was interrupted — retrying.");
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastEventId is a closure var, not state; re-running on run.status change is intentional
  }, [run.status, run.id]);

  const report = useMemo<RunReport | null>(() => {
    if (!run.reportJson) return null;
    try { return JSON.parse(run.reportJson) as RunReport; } catch { return null; }
  }, [run.reportJson]);

  // UI-3 (WEBTESTER-AUDIT): copy must follow the actual status. "the agents are still
  // working" was printed even on a finished run with zero findings.
  const isTerminal = run.status !== "running" && run.status !== "queued";

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

  // Live view (V8): CDP screencast frames, pushed over SSE when the runner shares
  // this process (every UI-launched run) and polled from the frame file otherwise
  // (CLI runs, which have no in-process publisher). Each frame is preloaded
  // off-DOM and only swapped in once decoded, so the <img> never blanks between
  // frames — this is what makes it read as video instead of a slideshow.
  // Raw last-received frame; the rendered value is derived below so stopping the
  // run / pinning a role hides the live frame without a setState inside the effect.
  const [rawLiveFrame, setLiveFrame] = useState<string | null>(null);
  const liveFrame = run.status === "running" && !pinnedRole ? rawLiveFrame : null;
  useEffect(() => {
    if (run.status !== "running" || pinnedRole) return;
    let alive = true;
    let pushed = false; // an SSE frame arrived → the poll stands down
    let timer: ReturnType<typeof setTimeout>;

    const paint = (src: string) => {
      const img = new Image();
      img.onload = () => { if (alive) setLiveFrame(img.src); };
      img.src = src;
    };

    const es = new EventSource(`/api/runs/${run.id}/frames`);
    es.onmessage = (e) => { pushed = true; paint(`data:image/jpeg;base64,${e.data}`); };
    es.onerror = () => { pushed = false; }; // EventSource reconnects itself; the poll covers the gap

    const tick = () => {
      if (pushed) { timer = setTimeout(tick, 1000); return; } // push is live — don't fetch behind its back
      const img = new Image();
      img.onload = () => { if (!alive) return; setLiveFrame(img.src); timer = setTimeout(tick, interactive ? 100 : 250); };
      img.onerror = () => { if (alive) timer = setTimeout(tick, 2000); }; // no frame yet (run warming up / non-chromium)
      img.src = `/shots/${run.id}/live.jpg?t=${Date.now()}`;
    };
    tick();

    return () => { alive = false; clearTimeout(timer); es.close(); };
  }, [run.status, run.id, pinnedRole, interactive]);

  // Narration + agent timeline (V3): "status" events answer what an agent is doing
  // right now; agent-start/agent-done (emitted once, in withRecovery) drive the
  // queued/running/done state of every agent the Mission Planner scheduled.
  const latestStatus = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].level === "status") return events[i];
    return null;
  }, [events]);

  // P1-17 (WEBTESTER-AUDIT): one shared ran/skipped derivation with the Markdown
  // exporter — an agent with findings or an agent-done event is never shown skipped.
  const agentView = useMemo(() => {
    if (!report) return null;
    const eventRan = new Set<string>();
    for (const e of events) if (e.level === "agent-done" || e.level === "agent-start") eventRan.add(e.agent);
    return deriveAgentView(report, findings.rows.map((f) => f.agent), eventRan);
  }, [report, events, findings.rows]);

  const timelineRows = useMemo(() => {
    const skipReason = new Map((agentView?.skipped ?? []).map((s) => [s.name, s.reason]));
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
  }, [run.missionAgents, run.status, events, agentView?.skipped]);

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
    const skipReason = new Map((agentView?.skipped ?? []).map((s) => [s.name, s.reason]));
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
  }, [report, agentView?.skipped]);

  // Code-aware root cause (V7): hints are keyed by finding fingerprint in the report.
  const hintByFingerprint = useMemo(
    () => new Map((report?.rootCauseHints ?? []).map((h) => [h.findingFingerprint, h])),
    [report]
  );

  const pendingQuestion = useMemo(() => questions.find((q) => q.status === "pending") ?? null, [questions]);

  async function sendAnswer() {
    if (!pendingQuestion || !answer.trim()) return;
    setBusy(true);
    // UI-4 (WEBTESTER-AUDIT): a swallowed failure here looked exactly like success —
    // the agent kept waiting while the user believed they had answered.
    try {
      const res = await fetch(`/api/runs/${run.id}/questions`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({ questionId: pendingQuestion.id, answer: answer.trim() }),
      });
      if (!res.ok) setPollError(`Your answer was rejected by the server (HTTP ${res.status}). The agent is still waiting.`);
      else setPollError(null);
    } catch {
      setPollError("Your answer could not be sent — the agent is still waiting.");
    }
    setAnswer("");
    setBusy(false);
  }

  // Interactive live view: the frame is a real screencast of the page the agents
  // are driving, so a click/keystroke here goes straight back into that page over
  // CDP. Coordinates are sent as 0..1 fractions — the server maps them to the
  // real viewport, so the img can be any size on screen.
  // Both control endpoints (drive the browser, answer an agent's question) are
  // origin-guarded and take the same optional token.
  const controlHeaders = { "Content-Type": "application/json", ...(controlToken ? { "x-control-token": controlToken } : {}) };
  // UI-4: control failures are surfaced. Silently dropping them meant a click that
  // never reached the browser was indistinguishable from one that did nothing.
  const sendInput = (body: Record<string, unknown>) =>
    fetch(`/api/runs/${run.id}/input`, { method: "POST", headers: controlHeaders, body: JSON.stringify(body) })
      .then((res) => {
        if (!res.ok) setPollError(`The browser did not accept that input (HTTP ${res.status}). Live control may not be authorised for this deployment.`);
      })
      .catch(() => setPollError("Could not reach the live browser — input was not delivered."));

  // Taking control holds a lease on the run: agents wait at their next boundary
  // instead of navigating the page out from under you. The lease expires server
  // side (30s), so a closed tab can never wedge a run — hence the heartbeat.
  function toggleControl() {
    const next = !interactive;
    setInteractive(next);
    void sendInput({ kind: next ? "hold" : "release" });
  }

  useEffect(() => {
    if (!interactive) return;
    const beat = setInterval(() => void sendInput({ kind: "hold" }), 10_000);
    return () => {
      clearInterval(beat);
      void sendInput({ kind: "release" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendInput is recreated each render; only the on/off edge matters
  }, [interactive, run.id]);

  const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
  const BUTTONS = ["left", "middle", "right"] as const;

  // The frame is object-contain, so the painted image is letterboxed inside the
  // element — map through the drawn rect, not the element box, or clicks drift.
  function framePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const el = frameRef.current;
    if (!el || !el.naturalWidth) return null;
    const box = el.getBoundingClientRect();
    const scale = Math.min(box.width / el.naturalWidth, box.height / el.naturalHeight);
    const drawnW = el.naturalWidth * scale;
    const drawnH = el.naturalHeight * scale;
    const x = (clientX - box.left - (box.width - drawnW) / 2) / drawnW;
    const y = (clientY - box.top - (box.height - drawnH) / 2) / drawnH;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }

  // press/move/release rather than one "click": that is what makes drag, hover
  // menus, text selection and right-click behave like a real browser.
  function onFrameDown(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive) return;
    const p = framePoint(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    dragging.current = e.button === 0;
    spawnRipple(e.clientX, e.clientY); // visual "click registered" feedback — the only cue that isn't hidden behind frame latency
    void sendInput({ kind: "down", ...p, button: BUTTONS[e.button] ?? "left", mods: mods(e) });
  }

  function onFrameUp(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive) return;
    const p = framePoint(e.clientX, e.clientY);
    dragging.current = false;
    if (p) void sendInput({ kind: "up", ...p, button: BUTTONS[e.button] ?? "left", mods: mods(e) });
  }

  function onFrameMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive) return;
    const now = Date.now();
    if (now - lastMove.current < 60) return; // ponytail: fixed 60ms throttle — enough for hover/drag, cheap on the wire
    lastMove.current = now;
    const p = framePoint(e.clientX, e.clientY);
    if (p) void sendInput({ kind: "move", ...p, buttons: dragging.current ? 1 : 0, mods: mods(e) });
  }

  function onFrameDoubleClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive) return;
    const p = framePoint(e.clientX, e.clientY);
    if (p) void sendInput({ kind: "click", ...p, clickCount: 2, mods: mods(e) }); // word-select, and apps that only listen for dblclick
  }

  function onFrameWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!interactive) return;
    const p = framePoint(e.clientX, e.clientY);
    if (p) void sendInput({ kind: "scroll", ...p, deltaY: e.deltaY, deltaX: e.deltaX, mods: mods(e) });
  }

  const NAMED_KEYS = new Set([
    "Enter", "Tab", "Backspace", "Delete", "Escape", "Home", "End", "PageUp", "PageDown",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ]);
  function onFrameKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    const shortcut = e.ctrlKey || e.metaKey || e.altKey; // ctrl+a / ctrl+c / ctrl+v — the page's own handlers must see the keydown
    if (NAMED_KEYS.has(e.key) || (shortcut && e.key.length === 1)) {
      e.preventDefault();
      void sendInput({ kind: "key", key: e.key, mods: mods(e) });
    } else if (e.key.length === 1) {
      e.preventDefault();
      void sendInput({ kind: "text", text: e.key }); // a typed character is a paste of one character
    }
  }

  function onFramePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    void sendInput({ kind: "text", text });
  }

  function toggleSeverity(s: Severity) {
    const next = new Set(severities);
    if (next.has(s)) next.delete(s); else next.add(s);
    const all = next.size === 0 || next.size === SEVERITY_ORDER.length;
    setParams({ sev: all ? null : SEVERITY_ORDER.filter((x) => next.has(x)).join(","), fp: null });
  }

  const findingPages = Math.max(1, Math.ceil(findings.total / pageSize));
  const timelinePages = Math.max(1, Math.ceil(timeline.total / (pageSize * 2)));

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
        <div className="flex flex-col items-end gap-2">
          {/* Both values are relative to "now": the server rendered "13m 45s" and
              a second later the client rendered "13m 46s" — a hydration mismatch.
              Render them only after mount, and tick so a live run counts up. */}
          <div className="font-mono text-xs text-muted">
            {tick > 0 && <>Started {timeAgo(run.startedAt)} · {duration(run.startedAt, run.finishedAt)}</>}
            {run.aiTokens > 0 ? `${tick > 0 ? " · " : ""}${run.aiTokens} AI tokens` : ""}
          </div>
          <div className="flex gap-2">
            {run.status === "running" && (
              <button
                onClick={() => { setBusy(true); void stopRunAction(run.id).finally(() => setBusy(false)); }}
                disabled={busy}
                className="rounded-md border border-amber-500/40 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-amber-300 transition-colors hover:bg-amber-500/10 disabled:opacity-40"
              >
                ■ Stop
              </button>
            )}
            {(run.status === "error" || run.status === "cancelled") && (
              <button
                onClick={() => { setBusy(true); void retryRunAction(run.id).finally(() => setBusy(false)); }}
                disabled={busy}
                className="rounded-md border border-indigo-500/40 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-indigo-300 transition-colors hover:bg-indigo-500/10 disabled:opacity-40"
              >
                ↻ Resume
              </button>
            )}
            <button
              onClick={() => {
                if (!confirm("Delete this run and everything it recorded?")) return;
                setBusy(true);
                void deleteRunAction(run.id).finally(() => setBusy(false));
              }}
              disabled={busy}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
            >
              Delete
            </button>
          </div>
          {run.status !== "running" && (
            <div className="flex gap-2">
              {(["md", "pdf"] as const).map((f) => (
                <a
                  key={f}
                  href={`/api/runs/${run.id}/report?format=${f}`}
                  className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-indigo-500/40 hover:text-foreground"
                >
                  ↓ {f}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* UI-2/UI-4: connection and control problems are shown, never swallowed. */}
      {pollError && (
        <Card role="status" className="border-l-2 border-l-orange-500 p-3 text-sm text-orange-200">
          {pollError}
        </Card>
      )}

      {/* UI-1 (WEBTESTER-AUDIT): the verdict, and WHY. The runner has recorded
          statusReason / executionOutcome / agentsFailed since the P0-2 work; the
          dashboard never showed them, so an `inconclusive` run looked like an
          unexplained amber twin of `cancelled`. This is where the run explains itself. */}
      {isTerminal && (report?.statusReason || report?.agentsFailed?.length) && (
        <Card className={`border-l-2 p-4 text-sm ${VERDICT_ACCENT[run.status] ?? "border-l-line"}`}>
          <div className="section-label">Why this verdict</div>
          <p className="mt-2">
            <span className="font-medium uppercase">{run.status}</span>
            {report.statusReason ? <> — {report.statusReason}.</> : null}
          </p>
          {report.executionOutcome === "partial" && (
            <p className="mt-2 text-amber-200">
              Execution was <span className="font-medium">partial</span>: not every scheduled agent finished, so this run&apos;s
              evidence is incomplete. Absence of a finding here does not mean absence of the problem.
            </p>
          )}
          {!!report.agentsFailed?.length && (
            <div className="mt-3">
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted">
                Tester failures — {report.agentsFailed.length} agent(s) could not complete
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {report.agentsFailed.map((a) => (
                  <li key={a.name} className="font-mono text-[11px] text-orange-300">
                    <span className="text-foreground">{a.name}</span> — {a.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                These are failures of the tester, not findings about your app. They are listed separately for exactly that reason.
              </p>
            </div>
          )}
        </Card>
      )}

      {run.summary && <Card className="whitespace-pre-line border-l-2 border-l-indigo-500 p-4 text-sm">{run.summary}</Card>}

      {pendingQuestion && (
        <Card className="border-l-2 border-l-amber-500 p-4">
          <div className="section-label text-amber-300">The agent needs you</div>
          <p className="mt-2 text-sm">
            <span className="font-mono text-[11px] text-muted">[{pendingQuestion.agent}]</span> {pendingQuestion.question}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendAnswer(); }}
              placeholder='e.g. "pass: hunter2" — or sign in yourself above and type "continue"'
              className="min-w-64 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-amber-500/50"
            />
            <button
              onClick={() => void sendAnswer()}
              disabled={busy || !answer.trim()}
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-300 disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted">
            The run is paused on this step and continues on its own if nobody answers.
          </p>
        </Card>
      )}

      {(shots.length > 0 || liveFrame) && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="section-label">Live view</div>
            <div className="flex items-center gap-2">
              {run.status === "running" && liveFrame && (
                <button
                  onClick={toggleControl}
                  title="Drive the page the agents are driving — they wait while you hold the wheel"
                  className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${interactive ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-line text-muted hover:text-foreground"}`}
                >
                  {interactive ? "✋ You have control" : "Take control"}
                </button>
              )}
            {(liveFrame || latestShot) && (
              <div className="flex gap-1">
                {(["fit", 100, 125, 150, 200] as const).map((z) => (
                  <button
                    key={z}
                    onClick={() => setZoom(z)}
                    className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${zoom === z ? "bg-indigo-500/15 text-indigo-300" : "text-muted hover:text-foreground"}`}
                  >
                    {z === "fit" ? "Fit" : `${z}%`}
                  </button>
                ))}
              </div>
            )}
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
          </div>
          {liveFrame || latestShot ? (
            <>
              {interactive && liveFrame && (
                <div className="mt-2 flex items-center gap-1">
                  {([["back", "←"], ["forward", "→"], ["reload", "⟳"]] as const).map(([to, glyph]) => (
                    <button
                      key={to}
                      onClick={() => void sendInput({ kind: "nav", to })}
                      title={to}
                      className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted hover:text-foreground"
                    >
                      {glyph}
                    </button>
                  ))}
                  <input
                    value={urlBar}
                    onChange={(e) => setUrlBar(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || !urlBar.trim()) return;
                      const to = /^https?:\/\//i.test(urlBar.trim()) ? urlBar.trim() : `https://${urlBar.trim()}`;
                      void sendInput({ kind: "nav", to });
                    }}
                    placeholder="https://… — navigate the live page"
                    className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11px] outline-none focus:border-emerald-500/50"
                  />
                </div>
              )}
              <div
                ref={frameWrapRef}
                tabIndex={interactive ? 0 : -1}
                onKeyDown={onFrameKey}
                onPaste={onFramePaste}
                onWheel={onFrameWheel}
                className={`relative mt-2 max-h-[28rem] overflow-auto rounded-lg outline-none ${interactive ? "ring-2 ring-emerald-500/50" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- runtime screenshot with unknown dimensions, not a static asset */}
                <img
                  ref={frameRef}
                  src={liveFrame ?? latestShot!.src}
                  alt=""
                  onMouseDown={onFrameDown}
                  onMouseUp={onFrameUp}
                  onMouseMove={onFrameMove}
                  onMouseLeave={() => { dragging.current = false; }}
                  onDoubleClick={onFrameDoubleClick}
                  onContextMenu={(e) => { if (interactive) e.preventDefault(); }} // the page's own context menu shows up in the frame instead
                  draggable={false}
                  style={zoom === "fit" ? undefined : { transform: `scale(${zoom / 100})`, transformOrigin: "top left" }}
                  className={`max-h-[28rem] w-full select-none rounded-lg border border-line bg-panel-2 object-contain object-top ${interactive ? "cursor-crosshair" : ""}`}
                />
                {ripples.map((r) => (
                  <span
                    key={r.id}
                    className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-emerald-400/70"
                    style={{ left: r.x, top: r.y }}
                  />
                ))}
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-muted">
                {liveFrame
                  ? interactive ? "● live · you have the wheel — agents wait. click the frame first, then click/drag/type (ctrl+a, ctrl+v and Enter all reach the page)" : "● live"
                  : <>{latestShot!.role ? `${latestShot!.role} · ` : ""}{/* fixed locale, not [] — the server's default locale rendered "05:50:32 pm" while the browser rendered "17:50:32", which is a hydration mismatch */}
                    {new Date(latestShot!.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</>}
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
            <span>Ran: {(agentView?.ran ?? report.agentsRan).join(", ") || "—"}</span>
            {(agentView?.skipped ?? report.agentsSkipped).length > 0 && (
              <span className="text-amber-400/80">Skipped: {(agentView?.skipped ?? report.agentsSkipped).map((a) => `${a.name} (${a.reason})`).join(", ")}</span>
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
            {v} {v === "findings" ? `(${findingsTotal})` : `(${timeline.total})`}
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
            <select
              value={kind}
              onChange={(e) => setParams({ kind: e.target.value === "all" ? null : e.target.value, fp: null })}
              className="rounded-md border border-line bg-panel px-3 py-1 text-xs"
            >
              <option value="all">All kinds</option>
              <option value="bug">Bugs</option>
              <option value="improvement">Improvements</option>
            </select>
            <select
              value={agent}
              onChange={(e) => setParams({ agent: e.target.value === "all" ? null : e.target.value, fp: null })}
              className="rounded-md border border-line bg-panel px-3 py-1 text-xs"
            >
              <option value="all">All agents</option>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <span className="font-mono text-[11px] text-muted">
              {findings.total} match{findings.total === 1 ? "" : "es"}
            </span>
          </div>

          {findings.rows.length === 0 ? (
            <Card className="px-5 py-12 text-center text-sm text-muted">
              {findingsTotal > 0
                ? "No findings match these filters."
                : !isTerminal
                  ? "No findings yet — the agents are still working."
                  : run.status === "passed"
                    ? "No findings. Every scheduled agent completed and nothing critical or high was found."
                    : run.status === "inconclusive"
                      ? "No findings recorded — but agents failed, so this run proves nothing. See “Why this verdict” above."
                      : run.status === "cancelled"
                        ? "No findings were recorded before this run was stopped."
                        : "No findings were recorded before this run ended."}
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {findings.rows.map((f) => (
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
                      {f.afterHuman && (
                        <span
                          title="Recorded after a human drove the live view — the page state was not reached by agents alone"
                          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] text-amber-300"
                        >
                          after manual control
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 break-words font-medium">{f.title}</p>
                    {(() => {
                      // Plain sentence first, raw evidence folded away — the list
                      // has to be readable by whoever decides if this matters.
                      const plain = plainImpact(f);
                      if (!plain) return <p className="mt-0.5 whitespace-pre-line break-words text-sm text-muted">{f.detail}</p>;
                      return (
                        <>
                          <p className="mt-1 break-words text-sm">{plain}</p>
                          <details className="mt-1">
                            <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-muted/70">Technical detail</summary>
                            <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">{f.detail}</p>
                          </details>
                        </>
                      );
                    })()}
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
          <Pager page={query.fp} pages={findingPages} onGo={(p) => setParams({ fp: p === 1 ? null : String(p) })} />
        </div>
      ) : (
        <Card className="p-0">
          <div ref={timelineRef} className="max-h-[32rem] overflow-y-auto p-4 font-mono text-[13px]">
            {timeline.rows.map((e) => (
              <div key={e.id} className="flex items-start gap-3 border-b border-line/60 py-2 last:border-0">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[e.level]}`} />
                <span className="w-24 shrink-0 truncate text-[11px] text-muted">{e.agent}</span>
                <span className="min-w-0 flex-1 break-words">{e.message}</span>
                {/* fixed locale, not [] — the server and the browser format differently, which hydration flags */}
                <span className="w-14 shrink-0 text-right text-[11px] text-muted">{new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-line/60 px-4">
            <Pager page={query.tp} pages={timelinePages} onGo={(p) => setParams({ tp: p === 1 ? null : String(p) })} />
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
