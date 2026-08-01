import type { CDPSession } from "playwright";

/**
 * Live control plane for an in-flight run: the interactive browser (drive the
 * real page the agents are driving) and the cancel signal.
 *
 * Same-process only, by design — the UI's route handlers and `executeRun` share
 * a Node process for UI-launched runs, which is the only case that has a human
 * watching. CLI runs simply have no live controller registered.
 */

export class RunCancelledError extends Error {
  constructor() {
    super("Run stopped by the user");
    this.name = "RunCancelledError";
  }
}

export interface Mods { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type MouseButton = "left" | "right" | "middle";

export type InputEvent =
  // x/y are 0..1 fractions of the frame, so the UI never needs the real viewport size
  | { kind: "click"; x: number; y: number; button?: MouseButton; clickCount?: number; mods?: Mods }
  | { kind: "down"; x: number; y: number; button?: MouseButton; mods?: Mods }
  | { kind: "up"; x: number; y: number; button?: MouseButton; mods?: Mods }
  | { kind: "move"; x: number; y: number; buttons?: number; mods?: Mods }
  | { kind: "scroll"; x: number; y: number; deltaY: number; deltaX?: number; mods?: Mods }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string; mods?: Mods }
  | { kind: "nav"; to: string } // "back" | "forward" | "reload" | an http(s) url
  | { kind: "hold" } // human takes the wheel (also renews the lease)
  | { kind: "release" };

export const INPUT_KINDS = ["click", "down", "up", "move", "scroll", "text", "key", "nav", "hold", "release"];

/**
 * The live-view OWNER page's CDP session, per run (WEBTESTER-AUDIT P1-4).
 *
 * Previously "last page to paint wins": with parallel agents, several roles, and
 * extra profiles all screencasting, the stream flickered between unrelated pages
 * and a human's click could land in whichever tab painted last. Ownership is now
 * explicit and STICKY — a second page only takes over when the owner has gone
 * quiet (closed, or no frame within the handover window), and never while a human
 * is holding the wheel on it.
 */
const HANDOVER_MS = 2_000;

const liveSessions = new Map<string, { cdp: CDPSession; width: number; height: number; ownerKey: string; lastFrameMs: number }>();

/** True if this page may own the live view right now. */
export function claimLiveOwner(runId: string, ownerKey: string, nowMs = Date.now()): boolean {
  const cur = liveSessions.get(runId);
  if (!cur) return true;
  if (cur.ownerKey === ownerKey) return true;
  if (humanHasControl(runId)) return false; // never steal the tab a human is driving
  return nowMs - cur.lastFrameMs > HANDOVER_MS; // owner went quiet — hand over
}

export function setLiveSession(runId: string, ownerKey: string, cdp: CDPSession, width: number, height: number): void {
  if (!claimLiveOwner(runId, ownerKey)) return;
  liveSessions.set(runId, { cdp, width, height, ownerKey, lastFrameMs: Date.now() });
}

export function liveOwnerKey(runId: string): string | null {
  return liveSessions.get(runId)?.ownerKey ?? null;
}

export function clearLiveSession(runId: string, cdp: CDPSession): void {
  if (liveSessions.get(runId)?.cdp === cdp) liveSessions.delete(runId);
}

export function hasLiveSession(runId: string): boolean {
  return liveSessions.has(runId);
}

// --- Who has the wheel ----------------------------------------------------
//
// Agents and the human drive the SAME page, so without a hand-off they fight:
// the human types a password while the interaction agent navigates away. A
// human "hold" is a lease, not a lock — the tab can close mid-hold, and a run
// that waits forever for a human who walked away is worse than one that races.

const CONTROL_LEASE_MS = 30_000;
const humanControl = new Map<string, number>(); // runId -> lease expiry (ms epoch)

// A human grabbing the wheel is proof somebody is watching — RunContext registers
// itself here so a take-control click can undo an earlier `askHuman` timeout
// (context.ts's `nobodyWatching`) instead of leaving questions muted for the rest
// of the run.
const controlWatchers = new Map<string, () => void>();

export function registerControlWatcher(runId: string, onGrab: () => void): void {
  controlWatchers.set(runId, onGrab);
}

export function unregisterControlWatcher(runId: string): void {
  controlWatchers.delete(runId);
}

export function grabControl(runId: string): void {
  humanControl.set(runId, Date.now() + CONTROL_LEASE_MS);
  controlWatchers.get(runId)?.();
}

export function releaseControl(runId: string): void {
  humanControl.delete(runId);
}

export function humanHasControl(runId: string): boolean {
  const until = humanControl.get(runId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  humanControl.delete(runId); // lease expired — the watcher left, agents resume
  return false;
}

/**
 * Block while a human is driving. Called at the agent boundary, so an agent
 * already mid-action finishes it — the hand-off is between agents, not between
 * keystrokes.
 * ponytail: agent-granularity hand-off. Push the wait into the per-action
 * helpers if an agent's own steps still trample the human's typing.
 */
export async function waitForHuman(runId: string, onWait?: () => void, onTick?: () => void): Promise<void> {
  if (!humanHasControl(runId)) return;
  onWait?.();
  while (humanHasControl(runId)) {
    onTick?.(); // throws on Stop — pressing Stop while holding the wheel must not wait out the lease
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --- Input translation ----------------------------------------------------

/** CDP's modifier bitmask: alt=1, ctrl=2, meta=4, shift=8. */
export function modifierMask(m: Mods = {}): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const NAMED_KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 }, Tab: { code: "Tab", vk: 9 }, Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 }, Escape: { code: "Escape", vk: 27 }, Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 }, PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 },
  ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
};

/**
 * A key name from the browser (`KeyboardEvent.key`) → what CDP needs. Named keys
 * come from the table; single characters are derived, which is what makes
 * shortcuts (ctrl+a, ctrl+c, ctrl+v) work — a plain character with no modifier
 * is sent as text instead, so this only has to cover the shortcut case.
 */
export function keyInfo(key: string): { key: string; code: string; vk: number } | null {
  const named = NAMED_KEYS[key];
  if (named) return { key, code: named.code, vk: named.vk };
  if (key.length !== 1) return null;
  const up = key.toUpperCase();
  if (up >= "A" && up <= "Z") return { key, code: `Key${up}`, vk: up.charCodeAt(0) };
  if (up >= "0" && up <= "9") return { key, code: `Digit${up}`, vk: up.charCodeAt(0) };
  return null;
}

/** Only real web navigation. `file:`/`chrome:` would turn the automation browser into a local file reader. */
export function isNavigable(to: string): boolean {
  return to === "back" || to === "forward" || to === "reload" || /^https?:\/\//i.test(to);
}

/**
 * Dispatch a human input event into the live page over CDP. Raw CDP (not
 * page.click) on purpose: the coordinates come from the screencast frame, so
 * they're viewport pixels — there is no selector to hand Playwright.
 */
export async function dispatchInput(runId: string, ev: InputEvent): Promise<boolean> {
  if (ev.kind === "hold") { grabControl(runId); return true; }
  if (ev.kind === "release") { releaseControl(runId); return true; }
  const live = liveSessions.get(runId);
  if (!live) return false;
  if (humanHasControl(runId)) grabControl(runId); // any input renews the lease — typing means still here
  const { cdp, width, height } = live;
  const px = (fx: number, span: number): number => Math.round(Math.min(Math.max(fx, 0), 1) * span);
  try {
    if (ev.kind === "click" || ev.kind === "down" || ev.kind === "up") {
      const base = {
        x: px(ev.x, width), y: px(ev.y, height), button: ev.button ?? "left",
        clickCount: ev.kind === "click" ? ev.clickCount ?? 1 : 1, modifiers: modifierMask(ev.mods),
      };
      const types = ev.kind === "click" ? (["mousePressed", "mouseReleased"] as const)
        : ev.kind === "down" ? (["mousePressed"] as const) : (["mouseReleased"] as const);
      for (const type of types) await cdp.send("Input.dispatchMouseEvent", { type, ...base });
    } else if (ev.kind === "move") {
      // `buttons` is what makes a drag a drag: 0 is a hover, 1 is left-held.
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: px(ev.x, width), y: px(ev.y, height),
        button: ev.buttons ? "left" : "none", buttons: ev.buttons ?? 0, modifiers: modifierMask(ev.mods),
      });
    } else if (ev.kind === "scroll") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: px(ev.x, width), y: px(ev.y, height),
        deltaX: ev.deltaX ?? 0, deltaY: ev.deltaY, button: "none", modifiers: modifierMask(ev.mods),
      });
    } else if (ev.kind === "text") {
      await cdp.send("Input.insertText", { text: ev.text });
    } else if (ev.kind === "nav") {
      if (!isNavigable(ev.to)) return false;
      if (ev.to === "reload") await cdp.send("Page.reload", {});
      else if (ev.to === "back" || ev.to === "forward") {
        const h = (await cdp.send("Page.getNavigationHistory")) as { currentIndex: number; entries: { id: number }[] };
        const target = h.entries[h.currentIndex + (ev.to === "back" ? -1 : 1)];
        if (!target) return false;
        await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
      } else await cdp.send("Page.navigate", { url: ev.to });
    } else {
      const k = keyInfo(ev.key);
      if (!k) return false;
      const modifiers = modifierMask(ev.mods);
      for (const type of ["keyDown", "keyUp"] as const) {
        await cdp.send("Input.dispatchKeyEvent", {
          type, key: k.key, code: k.code, modifiers,
          windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
        });
      }
    }
    return true;
  } catch {
    return false; // page navigated/closed mid-dispatch — the next frame shows the truth
  }
}
