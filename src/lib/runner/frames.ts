/**
 * In-process screencast frame bus for the live view.
 *
 * The runner already writes every frame to `shots/<run>/live.jpg` for the UI to
 * poll; polling costs a request round-trip per frame and shows whatever landed
 * on disk at fetch time. This bus pushes the same frames straight to the SSE
 * route, so an interactive session is limited by Chrome's paint rate, not by a
 * poll interval. Same-process only, like the input control plane — a CLI run has
 * no subscriber, and the file poll stays as the fallback for exactly that case.
 */

type FrameListener = (b64: string) => void;

const listeners = new Map<string, Set<FrameListener>>();
// ponytail: one jpeg per run kept so a new subscriber paints instantly instead of
// waiting for the next repaint. Runs are minutes long and frames are ~40KB — if
// this process ever holds thousands of concurrent runs, evict on run finish.
const latest = new Map<string, string>();

export function publishFrame(runId: string, b64: string): void {
  latest.set(runId, b64);
  const subs = listeners.get(runId);
  if (subs) for (const fn of subs) fn(b64);
}

export function latestFrame(runId: string): string | undefined {
  return latest.get(runId);
}

export function subscribeFrames(runId: string, fn: FrameListener): () => void {
  let subs = listeners.get(runId);
  if (!subs) listeners.set(runId, (subs = new Set()));
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (subs.size === 0) listeners.delete(runId);
  };
}
