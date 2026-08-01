import { dispatchInput, hasLiveSession, INPUT_KINDS, type InputEvent } from "@/lib/runner/control";
import { markHumanTakeover } from "@/lib/db";
import { controlAllowed } from "@/lib/originGuard";

/**
 * This endpoint is remote control of a real browser holding logged-in sessions
 * for every role under test — same-origin only, plus an optional shared token
 * (WEBTESTER_CONTROL_TOKEN) for anything that isn't a private localhost server.
 */
function allowed(req: Request): boolean {
  return controlAllowed(
    { origin: req.headers.get("origin"), host: req.headers.get("host"), token: req.headers.get("x-control-token") },
    process.env.WEBTESTER_CONTROL_TOKEN,
    process.env.WEBTESTER_ALLOWED_HOSTS
  );
}

/** Forwards a click/keystroke/navigation from the live view into the run's real browser page. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!allowed(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const ev = (await req.json().catch(() => null)) as InputEvent | null;
  if (!ev || !INPUT_KINDS.includes(ev.kind)) return Response.json({ error: "bad event" }, { status: 400 });
  // hold/release are about who drives, not about the page — they work before the
  // first frame arrives and keep working after the page under test closed.
  if (ev.kind !== "hold" && ev.kind !== "release" && !hasLiveSession(id)) {
    return Response.json({ error: "no live page for this run" }, { status: 409 });
  }
  if (ev.kind === "hold") markHumanTakeover(id); // evidence provenance: from here on, findings are not purely the app's doing
  const ok = await dispatchInput(id, ev);
  return Response.json({ ok });
}
