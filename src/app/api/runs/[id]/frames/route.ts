import { latestFrame, subscribeFrames } from "@/lib/runner/frames";
import { controlAllowed } from "@/lib/originGuard";

export const dynamic = "force-dynamic";

/**
 * Server-sent screencast frames for the live view: one base64 jpeg per message.
 * SSE rather than a WebSocket on purpose — App Router route handlers stream out
 * of the box, and frames only ever travel one way. Input still goes back over
 * the POST /input route, which is a request per keystroke and cheap.
 *
 * Same guard as the control routes: this is a live screencast of the authenticated
 * browser under test — a cross-origin/off-box page must not be able to watch it.
 * Caveat: the client (LiveRun.tsx) uses `new EventSource`, which cannot send custom
 * headers, so a hosted deployment with WEBTESTER_CONTROL_TOKEN set will 403 this
 * route for the app's own UI too — the plain-origin+loopback check below is what
 * covers the default local-dev case transparently (no Origin header on a same-origin
 * EventSource, loopback host, no token configured → allowed). A hosted setup needs
 * either a signed same-origin cookie or a short-lived query-string nonce instead of
 * a header — not implemented here, flagged for whoever hosts this.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = { origin: req.headers.get("origin"), host: req.headers.get("host"), token: req.headers.get("x-control-token") };
  // WEBTESTER_ALLOWED_HOSTS must be passed here exactly as the sibling input/questions
  // routes do (WEBTESTER-AUDIT P1-15): omitting it made this route's guard behave
  // differently from theirs — a deployment that legitimately allowlisted its own
  // hostname got 403 on the stream, and the divergence itself was the bug.
  if (!controlAllowed(guard, process.env.WEBTESTER_CONTROL_TOKEN, process.env.WEBTESTER_ALLOWED_HOSTS)) {
    return new Response("forbidden", { status: 403 });
  }
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (b64: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${b64}\n\n`));
        } catch {
          unsubscribe(); // client vanished between frames
        }
      };
      const first = latestFrame(id);
      if (first) send(first); // paint immediately instead of waiting for the next repaint
      unsubscribe = subscribeFrames(id, send);
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx would otherwise buffer the stream into uselessness
    },
  });
}
